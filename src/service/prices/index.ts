import { Logger } from "pino";
import BigNumber from "bignumber.js";
import * as StellarSdk from "stellar-sdk";
import * as StellarSdkNext from "stellar-sdk-next";
import { getSdk } from "../../helper/stellar";
import { NETWORK_URLS } from "../../helper/horizon-rpc";
import { TimeSeriesDuplicatePolicies } from "@redis/time-series";
import { ensureError } from "./errors";
import { RedisClientWithTS, TokenPriceData } from "./types";

/**
 * PriceClient is responsible for fetching, calculating, and caching token prices
 * from the Stellar network. It uses Redis time series for storing historical price data
 * and provides methods for retrieving current prices and price change percentages.
 */
export class PriceClient {
  /**
   * Stellar Asset for USDC.
   */
  private static readonly USDCAsset = new StellarSdk.Asset(
    "USDC",
    "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  );

  /**
   * Stellar Asset for the native asset (XLM).
   */
  private static readonly NativeAsset = StellarSdk.Asset.native();

  /**
   * The receiving value of the USDC asset used as the destination amount for
   * pathfinding to calculate the per-unit price of a token in USD.
   */
  private static readonly USD_RECIEIVE_VALUE = new BigNumber(500);

  /**
   * Redis key that indicates whether the price cache has been successfully initialized.
   * Set to "true" after PriceClient.initPriceCache() completes successfully.
   * Used by the worker to determine if initialization is needed on startup.
   */
  private static readonly PRICE_CACHE_INITIALIZED_KEY =
    "price_cache_initialized";

  /**
   * Prefix for Redis time series keys storing token price data.
   * Used to create consistent key naming for all token price time series.
   */
  private static readonly PRICE_TS_KEY_PREFIX = "ts:price";

  /**
   * Redis sorted set key that tracks token access frequency.
   * Each time a token price is accessed, its score is incremented.
   * Used to prioritize which tokens to update most frequently based on popularity.
   */
  private static readonly TOKEN_COUNTER_SORTED_SET_KEY = "token_counter";

  /**
   * Represents one day in milliseconds (24h * 60m * 60s * 1000ms).
   * Used when calculating 24-hour price changes in getPrice() method.
   */
  private static readonly ONE_DAY = 24 * 60 * 60 * 1000;

  /**
   * Represents one minute in milliseconds (60s * 1000ms).
   * Used as an offset window when looking up historical prices to handle slight timing variations.
   */
  private static readonly ONE_MINUTE = 60 * 1000;

  /**
   * The time period (in milliseconds) for which to retain price data in Redis time series.
   * Currently set to 1 day in milliseconds to support 24-hour price change calculations while managing storage usage.
   */
  private static readonly RETENTION_PERIOD = 24 * 60 * 60 * 1000;

  /**
   * Delay (in milliseconds) between processing batches of tokens during price updates.
   * Prevents overwhelming the Stellar network and API rate limits.
   */
  private static readonly BATCH_UPDATE_DELAY_MS = 5000;

  /**
   * Maximum time (in milliseconds) allowed for a single token's price calculation before timing out.
   * Prevents hanging operations when the Stellar network is slow or unresponsive for a particular token.
   */
  private static readonly PRICE_CALCULATION_TIMEOUT_MS = 10000;

  /**
   * Maximum number of tokens to process in a single batch during price updates.
   * Balances update efficiency with Stellar network and Redis load.
   */
  private static readonly TOKEN_UPDATE_BATCH_SIZE = 150;

  /**
   * Maximum number of tokens to fetch and track prices for initially.
   * Limits the total number of tokens to manage system resource usage.
   */
  private static readonly INITIAL_TOKEN_COUNT = 1000;

  /**
   * Stellar Expert API endpoint for fetching all tradable assets.
   */
  private static readonly STELLAR_EXPERT_ALL_ASSETS_URL =
    "https://api.stellar.expert/explorer/public/asset";

  /**
   * Base URL for Stellar Expert API calls.
   * Used to construct pagination URLs when fetching multiple pages of assets.
   */
  private static readonly STELLAR_EXPERT_BASE_URL =
    "https://api.stellar.expert";

  private readonly logger: Logger;
  private readonly server: StellarSdk.Horizon.Server;

  /**
   * Creates a new PriceClient instance.
   *
   * @param logger - The logger instance for logging events and errors
   * @param redisClient - Optional Redis client with time series support for caching prices
   */
  constructor(
    logger: Logger,
    private readonly redisClient?: RedisClientWithTS,
  ) {
    this.logger = logger;
    const Sdk = getSdk(StellarSdkNext.Networks.PUBLIC);
    const { Horizon } = Sdk;
    this.server = new Horizon.Server(NETWORK_URLS.PUBLIC, {
      allowHttp: true,
    });
  }

  /**
   * Retrieves the current price and 24-hour price change percentage for a token.
   * If the token is not in the cache, it also adds it to the cache.
   *
   * @param token - The token identifier in format "code:issuer" or "native" for native asset
   * @returns The token price data or null if price cannot be retrieved
   */
  getPrice = async (token: string): Promise<TokenPriceData | null> => {
    if (!this.redisClient) {
      return null;
    }

    const tsKey = this.getTimeSeriesKey(token);
    let latestPrice: { timestamp: number; value: number } | null = null;
    try {
      latestPrice = await this.redisClient.ts.get(tsKey);
    } catch (e) {
      return this.addNewTokenToCache(token);
    }

    try {
      if (!latestPrice) {
        return null;
      }

      // Get 24h ago price using TS.RANGE. Use a 1 min offset as the end time.
      const dayAgo = latestPrice.timestamp - PriceClient.ONE_DAY;
      const oldPrices = await this.redisClient.ts.range(
        tsKey,
        dayAgo,
        dayAgo + PriceClient.ONE_MINUTE,
        {
          COUNT: 1,
        },
      );

      const currentPrice = new BigNumber(latestPrice.value);
      let percentagePriceChange24h: BigNumber | null = null;

      if (oldPrices && oldPrices.length > 0) {
        const oldPriceBN = new BigNumber(oldPrices[0].value);
        if (!oldPriceBN.isZero()) {
          percentagePriceChange24h = currentPrice
            .minus(oldPriceBN)
            .dividedBy(oldPriceBN)
            .times(100);
        }
      }
      await this.redisClient.zIncrBy(
        PriceClient.TOKEN_COUNTER_SORTED_SET_KEY,
        1,
        tsKey,
      );

      return {
        currentPrice,
        percentagePriceChange24h,
      };
    } catch (e) {
      const error = ensureError(
        e,
        `getting price from time series for ${token}`,
      );
      this.logger.error(error);
      return null;
    }
  };

  /**
   * Initializes the price cache by fetching all tokens and creating time series
   * entries for each in Redis. This should be called once at service startup.
   *
   * @throws Error if Redis client is not initialized or price cache initialization fails
   */
  initPriceCache = async (): Promise<void> => {
    try {
      if (!this.redisClient) {
        throw new Error("Redis client not initialized");
      }

      const tokens = await this.fetchAllTokens();
      this.logger.info(`Fetched ${tokens.length} total tokens`);

      // Create time series and sorted set for each token and add it to Redis pipeline.
      const pipeline = this.redisClient.multi();
      for (const token of tokens) {
        const tsKey = this.getTimeSeriesKey(token);
        try {
          pipeline.ts.create(tsKey, {
            RETENTION: PriceClient.RETENTION_PERIOD,
            DUPLICATE_POLICY: TimeSeriesDuplicatePolicies.LAST,
            LABELS: {
              PRICE_CACHE_LABEL: PriceClient.PRICE_TS_KEY_PREFIX,
            },
          });
          pipeline.zIncrBy(PriceClient.TOKEN_COUNTER_SORTED_SET_KEY, 1, tsKey);
          this.logger.info(`Created time series ${tsKey}`);
          this.logger.info(`Added to sorted set ${tsKey}`);
        } catch (error) {
          this.logger.error(
            `Error creating time series for ${token}: ${error}`,
          );
        }
      }
      await pipeline.exec();
      await this.redisClient.set(
        PriceClient.PRICE_CACHE_INITIALIZED_KEY,
        "true",
      );
    } catch (error) {
      throw ensureError(error, `initializing price cache`);
    }
  };

  /**
   * Updates prices for all tokens in the cache. This method should be called
   * periodically to keep prices current.
   *
   * @throws Error if Redis client is not initialized or price update fails
   */
  updatePrices = async (): Promise<void> => {
    try {
      if (!this.redisClient) {
        throw new Error("Redis client not initialized");
      }

      const tokens = await this.getTokensToUpdate();
      await this.processTokenBatches(tokens);
    } catch (e) {
      throw ensureError(e, `updating prices`);
    }
  };

  /**
   * Retrieves tokens to update prices for, from the Redis sorted set, ordered by access frequency.
   *
   * @returns Array of token keys to update
   * @throws Error if no tokens are found in the sorted set
   * @private
   */
  private async getTokensToUpdate(): Promise<string[]> {
    const tokens = await this.redisClient!.zRange(
      PriceClient.TOKEN_COUNTER_SORTED_SET_KEY,
      0,
      -1,
      { REV: true },
    );

    if (tokens.length === 0) {
      throw new Error("No tokens found in sorted set");
    }

    return tokens;
  }

  /**
   * Processes tokens in batches to prevent overwhelming the network and API limits.
   * Each batch is processed with a delay between batches.
   *
   * @param tokens - Array of token keys to process
   * @private
   */
  private async processTokenBatches(tokens: string[]): Promise<void> {
    for (
      let i = 0;
      i < tokens.length;
      i += PriceClient.TOKEN_UPDATE_BATCH_SIZE
    ) {
      const tokenBatch = tokens.slice(
        i,
        i + PriceClient.TOKEN_UPDATE_BATCH_SIZE,
      );
      this.logger.info(
        `Processing batch ${i / PriceClient.TOKEN_UPDATE_BATCH_SIZE + 1} of ${Math.ceil(
          tokens.length / PriceClient.TOKEN_UPDATE_BATCH_SIZE,
        )}`,
      );

      await this.addBatchToCache(tokenBatch);
      await new Promise((resolve) =>
        setTimeout(resolve, PriceClient.BATCH_UPDATE_DELAY_MS),
      );
    }
  }

  /**
   * Adds a batch of new token prices and the timestamps to the Redis timeseries structure.
   *
   * @param tokenBatch - Array of token keys to add to cache
   * @throws Error if no prices could be calculated
   * @private
   */
  private async addBatchToCache(tokenBatch: string[]): Promise<void> {
    const prices = await this.calculateBatchPrices(tokenBatch);
    if (prices.length === 0) {
      throw new Error("No prices calculated");
    }

    const mAddEntries = prices.map(({ token, timestamp, price }) => ({
      key: this.getTimeSeriesKey(token),
      timestamp,
      value: price.toNumber(),
    }));
    await this.redisClient!.ts.mAdd(mAddEntries);
  }

  /**
   * Calculates prices for a batch of tokens in parallel.
   *
   * @param tokens - Array of token keys to calculate prices for
   * @returns Array of calculated prices with token, timestamp, and price information
   * @throws Error if batch price calculation fails
   * @private
   */
  private async calculateBatchPrices(
    tokens: string[],
  ): Promise<{ token: string; timestamp: number; price: BigNumber }[]> {
    try {
      const pricePromises = tokens.map((token) =>
        this.calculatePriceInUSD(token)
          .then((price) => ({
            token,
            timestamp: price.timestamp,
            price: price.price,
          }))
          .catch((e) => {
            const error = ensureError(e, `calculating price for ${token}`);
            this.logger.error(error);
            return null;
          }),
      );

      // Filter out null responses - these are tokens for which we failed to calculate a price.
      const prices = (await Promise.all(pricePromises)).filter(
        (
          price,
        ): price is { token: string; timestamp: number; price: BigNumber } =>
          price !== null,
      );

      return prices;
    } catch (e) {
      throw ensureError(e, `calculating batch prices for ${tokens}`);
    }
  }

  /**
   * Fetches all tradable tokens from Stellar Expert API.
   *
   * @returns Array of token identifiers in the format "code:issuer" or "XLM" for native asset
   * @private
   */
  private async fetchAllTokens(): Promise<string[]> {
    const tokens: string[] = ["XLM"];
    let nextUrl = `${PriceClient.STELLAR_EXPERT_ALL_ASSETS_URL}?sort=volume7d&order=desc`;

    while (tokens.length < PriceClient.INITIAL_TOKEN_COUNT && nextUrl) {
      try {
        this.logger.info(
          `Fetching assets from ${nextUrl}, current count: ${tokens.length}`,
        );
        const response = await fetch(`${nextUrl}`);
        const data = await response.json();

        if (data._embedded?.records) {
          for (const record of data._embedded.records) {
            let token: string | null = null;

            if (record.asset === "XLM" || record.asset === "USDC") {
              continue;
            } else if (record.tomlInfo?.code && record.tomlInfo?.issuer) {
              // Use TOML info if available
              token = `${record.tomlInfo.code}:${record.tomlInfo.issuer}`;
            } else if (record.asset && record.asset.includes("-")) {
              // Parse from asset string format: CODE-ISSUER
              const parts = record.asset.split("-");
              if (parts.length >= 2) {
                token = `${parts[0]}:${parts[1]}`;
              }
            }

            if (token && !tokens.includes(token)) {
              tokens.push(token);
            }
          }
        }

        // Check for next page
        nextUrl = data._links?.next?.href || null;
        nextUrl = `${PriceClient.STELLAR_EXPERT_BASE_URL}${nextUrl}`;
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        this.logger.error(`Error fetching assets: ${error}`);
        break;
      }
    }
    return tokens;
  }

  /**
   * Converts a token identifier to a Redis time series key.
   * Handles special case for "native" token which is converted to "XLM".
   *
   * @param token - Token identifier
   * @returns Redis time series key for the token
   * @private
   */
  private getTimeSeriesKey(token: string): string {
    let key = token;
    if (token === "native") {
      key = "XLM";
    }
    return key;
  }

  /**
   * Creates a new time series in Redis for a token and adds it to the sorted set.
   *
   * @param key - The time series key to create
   * @throws Error if Redis client is not initialized or time series creation fails
   * @private
   */
  private async createTimeSeries(key: string): Promise<void> {
    try {
      if (!this.redisClient) {
        throw new Error("Redis client not initialized");
      }

      await this.redisClient.ts.create(key, {
        RETENTION: PriceClient.RETENTION_PERIOD,
        DUPLICATE_POLICY: TimeSeriesDuplicatePolicies.LAST,
        LABELS: {
          PRICE_CACHE_LABEL: PriceClient.PRICE_TS_KEY_PREFIX,
        },
      });
      await this.redisClient.zIncrBy(
        PriceClient.TOKEN_COUNTER_SORTED_SET_KEY,
        1,
        key,
      );
      this.logger.info(`Created time series ${key}`);
      this.logger.info(`Added to sorted set ${key}`);
    } catch (e) {
      throw ensureError(e, `creating time series for ${key}`);
    }
  }

  /**
   * Adds a new token to the Redis price cache by calculating its current price
   * and creating a time series for it.
   *
   * @param token - Token identifier to add to cache
   * @returns The token price data or null if price calculation fails
   * @throws Error if Redis client is not initialized or adding token to cache fails
   * @private
   */
  private addNewTokenToCache = async (
    token: string,
  ): Promise<TokenPriceData | null> => {
    try {
      if (!this.redisClient) {
        throw new Error("Redis client not initialized");
      }

      const { timestamp, price } = await this.calculatePriceInUSD(token);
      const tsKey = this.getTimeSeriesKey(token);

      await this.createTimeSeries(tsKey);
      await this.redisClient.ts.add(tsKey, timestamp, price.toNumber());
      return { currentPrice: price, percentagePriceChange24h: null };
    } catch (e) {
      throw ensureError(e, `adding new token to cache for ${token}`);
    }
  };

  /**
   * Calculates the price of a token in USD with a timeout to prevent hanging.
   *
   * @param token - Token identifier to calculate price for
   * @returns Object containing timestamp and price in USD
   * @throws Error if price calculation fails or times out
   * @private
   */
  private calculatePriceInUSD = async (
    token: string,
  ): Promise<{ timestamp: number; price: BigNumber }> => {
    try {
      // Add a timeout to the price calculation
      const timeoutPromise = new Promise<{
        timestamp: number;
        price: BigNumber;
      }>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Price calculation timeout for ${token}`)),
          PriceClient.PRICE_CALCULATION_TIMEOUT_MS,
        ),
      );

      return await Promise.race([
        this.calculatePriceUsingPaths(token),
        timeoutPromise,
      ]);
    } catch (e) {
      throw ensureError(e, `calculating price for ${token}`);
    }
  };

  /**
   * Calculates the price of a token in USD using Horizon's path finding functionality.
   * Finds paths from the token to USDC and calculates the exchange rate.
   *
   * @param token - Token identifier to calculate price for
   * @returns Object containing timestamp and price in USD
   * @throws Error if no paths are found or price calculation fails
   * @private
   */
  private calculatePriceUsingPaths = async (
    token: string,
  ): Promise<{ timestamp: number; price: BigNumber }> => {
    try {
      let sourceAssets = undefined;
      if (token === "XLM") {
        sourceAssets = [PriceClient.NativeAsset];
      } else {
        const [code, issuer] = token.split(":");
        if (!code || !issuer) {
          throw new Error(
            `Invalid token format: ${token}. Expected 'code:issuer'`,
          );
        }
        sourceAssets = [
          new StellarSdk.Asset(code, issuer),
          PriceClient.NativeAsset,
        ];
      }

      const latestLedger = await this.server
        .ledgers()
        .order("desc")
        .limit(1)
        .call();
      const latestLedgerTimestamp = new Date(
        latestLedger.records[0].closed_at,
      ).getTime();

      const paths = await this.server
        .strictReceivePaths(
          sourceAssets,
          PriceClient.USDCAsset,
          PriceClient.USD_RECIEIVE_VALUE.toString(),
        )
        .call();
      if (!paths.records.length) {
        throw new Error(`No paths found for ${token}`);
      }

      const newPaths = paths.records.filter((record) => {
        return record.source_asset_code === sourceAssets[0].code;
      });

      const tokenUnit = new BigNumber(
        newPaths.reduce(
          (min, record) => Math.min(min, Number(record.source_amount)),
          Number(paths.records[0].source_amount),
        ),
      );
      const unitTokenPrice =
        PriceClient.USD_RECIEIVE_VALUE.dividedBy(tokenUnit);
      return { timestamp: latestLedgerTimestamp, price: unitTokenPrice };
    } catch (e) {
      throw ensureError(e, `calculating price using paths for ${token}`);
    }
  };
}
