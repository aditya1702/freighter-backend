import { OperationResult } from "@urql/core";
import * as StellarSdk from "stellar-sdk";
import BigNumber from "bignumber.js";
import {
  BASE_RESERVE,
  BASE_RESERVE_MIN_COUNT,
  NativeBalance,
  getAssetType,
} from "../../../helper/horizon-rpc";
import { formatTokenAmount } from "../../../helper/format";
import { getOpArgs, isSacContract } from "../../../helper/soroban-rpc";
import { getSdk } from "../../../helper/stellar";
import { NetworkNames } from "../../../helper/validate";

// Transformers take an API response, and transform it/augment it for frontend consumption

export interface BalanceMap {
  [key: string]: any;
  native: NativeBalance;
}

export type Balances = BalanceMap | null;

interface AccountBalancesInterface {
  balances: Balances;
  isFunded: boolean | null;
  subentryCount: number;
}

type MercuryAccountBalancesCurrentData = {
  trustlinesByPublicKey: {
    balance: string;
    asset: string;
    limit: number;
    accountId: string;
  }[];
  accountByPublicKey: {
    accountId: string;
    nativeBalance: string;
    buyingLiabilities: string;
    sellingLiabilities: string;
    seqNum: string;
    numSubentries: string;
    numSponsored: string;
    numSponsoring: string;
  };
} & {
  [key: string]: {
    contractId: string;
    keyXdr: string;
    valXdr: string;
    durability: string;
  };
};

type MercuryAccountBalancesData = {
  accountObjectByPublicKey: {
    nodes: {
      accountByAccount: {
        publickey: string;
      };
      nativeBalance: string;
      numSubEntries: string;
      numSponsored: string;
      numSponsoring: string;
      sellingLiabilities: string;
    }[];
  };
  balanceByPublicKey: {
    nodes: {
      assetByAsset: {
        code: string;
        issuer: string;
      };
      accountByAccount: {
        publickey: string;
      };
      balance: string;
    }[];
  };
} & {
  // each entryUpdateByContractIdAndKey query is aliased as the contract ID, to support querying for multiple balance entries
  [key: string]: {
    nodes: {
      contractId: string;
      keyXdr: string;
      valueXdr: string;
    }[];
  };
};

interface TokenDetails {
  [k: string]: {
    name: string;
    symbol: string;
    decimals: string;
    balance?: string;
  };
}

const transformAccountBalancesCurrentData = async (
  rawResponseCurrentData: OperationResult<MercuryAccountBalancesCurrentData>,
  tokenDetails: TokenDetails,
  contractIds: string[],
  networkpassPhrase: StellarSdk.Networks,
) => {
  const Sdk = getSdk(networkpassPhrase);
  const { xdr } = Sdk;
  const accountObject = rawResponseCurrentData?.data?.accountByPublicKey;
  const accountCurrentTrustlines =
    rawResponseCurrentData?.data?.trustlinesByPublicKey || [];

  const numSubEntries = accountObject?.numSubentries || "0";
  const numSponsoring = accountObject?.numSponsoring || "0";
  const numSponsored = accountObject?.numSponsored || "0";
  const sellingLiabilities = formatTokenAmount(
    new BigNumber(accountObject?.sellingLiabilities || "0"),
    7,
  );
  const buyingLiabilities = formatTokenAmount(
    new BigNumber(accountObject?.buyingLiabilities || "0"),
    7,
  );
  const nativeBalance = accountObject?.nativeBalance || "0";

  const accountBalance = {
    native: {
      token: { type: "native", code: "XLM" },
      total: formatTokenAmount(new BigNumber(nativeBalance), 7),
      available: formatTokenAmount(
        new BigNumber(nativeBalance).minus(
          new BigNumber(accountObject?.sellingLiabilities || "0"),
        ),
        7,
      ),
      buyingLiabilities,
      sellingLiabilities,
      minimumBalance: new BigNumber(BASE_RESERVE_MIN_COUNT)
        .plus(new BigNumber(numSubEntries))
        .plus(new BigNumber(numSponsoring))
        .minus(new BigNumber(numSponsored))
        .times(new BigNumber(BASE_RESERVE))
        .plus(
          new BigNumber(
            formatTokenAmount(new BigNumber(sellingLiabilities), 7),
          ),
        ),
    },
  };

  const classicBalances = accountCurrentTrustlines.reduce(
    (prev, curr) => {
      const tl = curr;
      const trustline = xdr.Asset.fromXDR(tl.asset, "base64");
      switch (trustline.switch().name) {
        case "assetTypeNative": {
          // not in this query, in account object query
          return prev;
        }

        case "assetTypeCreditAlphanum4": {
          const code = trustline.alphaNum4().assetCode().toString();
          const issuer = Sdk.StrKey.encodeEd25519PublicKey(
            trustline.alphaNum4().issuer().ed25519(),
          );
          prev[`${code}:${issuer}`] = {
            token: {
              code,
              issuer: {
                key: issuer,
              },
            },
            total: formatTokenAmount(new BigNumber(tl.balance), 7),
            available: formatTokenAmount(new BigNumber(tl.balance), 7),
          };
          return prev;
        }

        case "assetTypeCreditAlphanum12": {
          const code = trustline.alphaNum12().assetCode().toString();
          const issuer = Sdk.StrKey.encodeEd25519PublicKey(
            trustline.alphaNum12().issuer().ed25519(),
          );
          prev[`${code}:${issuer}`] = {
            token: {
              code,
              issuer: {
                key: issuer,
              },
            },
            total: formatTokenAmount(new BigNumber(tl.balance), 7),
            available: formatTokenAmount(new BigNumber(tl.balance), 7),
          };
          return prev;
        }

        case "assetTypePoolShare": {
          // Should pool shares be decoded here?
          return prev;
        }

        default:
          throw new Error("Asset type not suppported");
      }
    },
    {} as NonNullable<AccountBalancesInterface["balances"]>,
  );

  const tokenBalanceData = contractIds.map((id) => {
    const resData = rawResponseCurrentData?.data || ({} as any);
    const tokenRecord = resData[id] || [];
    return tokenRecord;
  });

  const formattedBalances = tokenBalanceData.map(([entry]) => {
    const details = tokenDetails[entry.contractId];
    const valEntry = xdr.LedgerEntry.fromXDR(entry.valXdr, "base64");
    const val = valEntry.data().contractData().val();
    return {
      ...entry,
      ...details,
      total: Sdk.scValToNative(val),
    };
  });

  const balances = formattedBalances
    .filter(
      (bal) => !isSacContract(bal.name, bal.contractId, networkpassPhrase),
    )
    .reduce(
      (prev, curr) => {
        prev[`${curr.symbol}:${curr.contractId}`] = {
          token: {
            code: curr.symbol,
            issuer: {
              key: curr.contractId,
            },
          },
          decimals: curr.decimals,
          total: new BigNumber(curr.total),
          available: new BigNumber(curr.total),
        };
        return prev;
      },
      {} as NonNullable<AccountBalancesInterface["balances"]>,
    );

  return {
    balances: {
      ...accountBalance,
      ...classicBalances,
      ...balances,
    },
    isFunded: true,
    subentryCount: 0,
  };
};

const transformAccountBalances = async (
  rawResponse: OperationResult<MercuryAccountBalancesData>,
  tokenDetails: TokenDetails,
  contractIds: string[],
  network: StellarSdk.Networks,
) => {
  const Sdk = getSdk(network);
  const accountObjectData =
    rawResponse?.data?.accountObjectByPublicKey.nodes || [];
  const classicBalanceData = rawResponse?.data?.balanceByPublicKey.nodes || [];

  const accountObject = accountObjectData[0];
  const numSubEntries = accountObject?.numSubEntries || "0";
  const numSponsoring = accountObject?.numSponsoring || "0";
  const numSponsored = accountObject?.numSponsored || "0";
  const sellingLiabilities = accountObject?.sellingLiabilities || "0";
  const nativeBalance = accountObject?.nativeBalance || "0";

  const accountBalance = {
    native: {
      token: { type: "native", code: "XLM" },
      total: formatTokenAmount(new BigNumber(nativeBalance), 7),
      available: new BigNumber(BASE_RESERVE_MIN_COUNT)
        .plus(new BigNumber(numSubEntries))
        .plus(new BigNumber(numSponsoring))
        .minus(new BigNumber(numSponsored))
        .times(new BigNumber(BASE_RESERVE))
        .plus(new BigNumber(sellingLiabilities)),
    },
  };

  const tokenBalanceData = contractIds.map((id) => {
    const resData =
      rawResponse?.data || ({} as { [index: string]: { nodes: [] } });
    const tokenRecord = resData[id] || { nodes: [] };
    return tokenRecord.nodes;
  });

  const formattedBalances = tokenBalanceData.map(([entry]) => {
    const details = tokenDetails[entry.contractId];
    const totalScVal = Sdk.xdr.ScVal.fromXDR(
      Buffer.from(entry.valueXdr, "base64"),
    );
    return {
      ...entry,
      ...details,
      total: Sdk.scValToNative(totalScVal),
    };
  });

  const balances = formattedBalances.reduce(
    (prev, curr) => {
      prev[`${curr.symbol}:${curr.contractId}`] = {
        token: {
          code: curr.symbol,
          issuer: {
            key: curr.contractId,
          },
        },
        decimals: curr.decimals,
        total: new BigNumber(curr.total),
        available: new BigNumber(curr.total),
      };
      return prev;
    },
    {} as NonNullable<AccountBalancesInterface["balances"]>,
  );

  const classicBalances = classicBalanceData.reduce(
    (prev, curr) => {
      const codeAscii = atob(curr.assetByAsset.code);
      prev[`${codeAscii}:${curr.assetByAsset.issuer}`] = {
        token: {
          code: codeAscii,
          issuer: {
            key: curr.assetByAsset.issuer,
          },
        },
        total: formatTokenAmount(new BigNumber(curr.balance), 7),
        available: formatTokenAmount(new BigNumber(curr.balance), 7),
      };
      return prev;
    },
    {} as NonNullable<AccountBalancesInterface["balances"]>,
  );

  return {
    balances: {
      ...accountBalance,
      ...classicBalances,
      ...balances,
    },
    isFunded: true,
    subentryCount: numSubEntries,
  };
};

const transformBaseOperation = (
  operation: BaseOperation,
  network: NetworkNames,
) => {
  const Sdk = getSdk(StellarSdk.Networks[network]);
  let isTxSuccessful = true;
  if (operation.txInfoByTx.resultXdr) {
    const { name } = Sdk.xdr.TransactionResult.fromXDR(
      operation.txInfoByTx.resultXdr,
      "base64",
    )
      .result()
      .switch();
    if (name === Sdk.xdr.TransactionResultCode.txFailed().name) {
      isTxSuccessful = false;
    }
  }
  return {
    created_at: new Date(
      operation.txInfoByTx.ledgerByLedger.closeTime * 1000,
    ).toISOString(),
    source_account: operation.source,
    transaction_hash: operation.tx,
    id: operation.opId,
    transaction_successful: isTxSuccessful,
    transaction_attr: {
      operation_count: operation.txInfoByTx.opCount,
      fee_charged: operation.txInfoByTx.fee,
    },
  } as Partial<
    StellarSdk.Horizon.ServerApi.BaseOperationRecord & {
      transaction_attr: object;
    }
  >;
};

interface BaseOperation {
  source: string;
  tx: string;
  opId: string;
  txInfoByTx: TxInfo;
}

interface TxInfo {
  fee: string;
  opCount: number;
  resultXdr: string;
  ledgerByLedger: {
    closeTime: number;
  };
}

type MercuryAccountHistory = {
  invokeHostFnByPublicKey: {
    edges: {
      node: {
        auth: string;
        hostFunction: string;
        sorobanMeta: string;
      } & BaseOperation;
    }[];
  };
  createAccountByPublicKey: {
    edges: {
      node: {
        destination: string;
        startingBalance: string;
      } & BaseOperation;
    }[];
  };
  createAccountToPublicKey: {
    edges: {
      node: {
        destination: string;
        startingBalance: string;
      } & BaseOperation;
    }[];
  };
  paymentsOfPublicKey: {
    edges: {
      node: {
        amount: string;
        assetNative: string;
        assetByAsset: {
          code: string;
          issuer: string;
        } | null;
        destination: string;
      } & BaseOperation;
    }[];
  };
  pathPaymentsStrictSendOfPublicKey: {
    nodes: ({
      destination: string;
      assetByDestAsset: {
        code: string;
        issuer: string;
      };
      assetByPath1: {
        code: string;
        issuer: string;
      };
      assetByPath2: {
        code: string;
        issuer: string;
      };
      assetByPath3: {
        issuer: string;
        code: string;
      };
      assetByPath4: {
        issuer: string;
        code: string;
      };
      assetByPath5: {
        issuer: string;
        code: string;
      };
      assetBySendAsset: {
        code: string;
        issuer: string;
      };
      destAssetNative: string;
      destMin: string;
      path1Native: string;
      path2Native: string;
      path3Native: string;
      path4Native: string;
      path5Native: string;
      sendAmount: string;
      sendAssetNative: string;
    } & BaseOperation)[];
  };
  pathPaymentsStrictReceiveOfPublicKey: {
    nodes: ({
      destination: string;
      assetByDestAsset: {
        code: string;
        issuer: string;
      };
      assetByPath1: {
        code: string;
        issuer: string;
      };
      assetByPath2: {
        code: string;
        issuer: string;
      };
      assetByPath3: {
        issuer: string;
        code: string;
      };
      assetByPath4: {
        issuer: string;
        code: string;
      };
      assetByPath5: {
        issuer: string;
        code: string;
      };
      assetBySendAsset: {
        code: string;
        issuer: string;
      };
      destAssetNative: string;
      destMin: string;
      path1Native: string;
      path2Native: string;
      path3Native: string;
      path4Native: string;
      path5Native: string;
      destAmount: string;
      sendAssetNative: string;
    } & BaseOperation)[];
  };
  manageBuyOfferByPublicKey: {
    edges: {
      node: {
        buyingNative: boolean;
        assetByBuying: {
          issuer: string;
          code: string;
        };
        assetBySelling: {
          code: string;
          issuer: string;
        };
        ledgerByLedger: {
          closeTime: number;
          sequence: string;
        };
        source: string;
        offerId: string;
        priceD: string;
        priceN: string;
        sellingNative: boolean;
      } & BaseOperation;
    }[];
  };
  manageSellOfferByPublicKey: {
    edges: {
      node: {
        buyingNative: boolean;
        assetByBuying: {
          issuer: string;
          code: string;
        };
        assetBySelling: {
          code: string;
          issuer: string;
        };
        ledgerByLedger: {
          closeTime: number;
          sequence: string;
        };
        source: string;
        offerId: string;
        priceD: string;
        priceN: string;
        sellingNative: boolean;
      } & BaseOperation;
    }[];
  };
  createPassiveSellOfferByPublicKey: {
    nodes: ({
      amount: string;
      assetByBuying: {
        code: string;
        issuer: string;
      };
      assetBySelling: {
        code: string;
        issuer: string;
      };
      buyingNative: boolean;
      ledgerByLedger: {
        closeTime: number;
        sequence: string;
      };
      source: string;
      priceD: string;
      priceN: string;
      sellingNative: boolean;
    } & BaseOperation)[];
  };
  changeTrustByPublicKey: {
    nodes: ({
      assetByLineAsset: {
        issuer: string;
        code: string;
      };
      limit: string;
      lineNative: boolean;
      poolshareByLinePoolShare: {
        assetByA: {
          code: string;
        };
        assetByB: {
          code: string;
        };
        fee: string;
      };
    } & BaseOperation)[];
  };
  accountMergeByPublicKey: {
    edges: {
      node: {
        destination: string;
        source: string;
      } & BaseOperation;
    }[];
  };
  bumpSequenceByPublicKey: {
    edges: {
      node: {
        source: string;
        bumpTo: string;
      } & BaseOperation;
    }[];
  };
  claimClaimableBalanceByPublicKey: {
    edges: {
      node: {
        source: string;
        balanceId: string;
      } & BaseOperation;
    }[];
  };
  createClaimableBalanceByPublicKey: {
    edges: {
      node: {
        amount: string;
        asset: string;
        assetNative: boolean;
        source: string;
      } & BaseOperation;
    }[];
  };
  allowTrustByPublicKey: {
    edges: {
      node: {
        authorize: boolean;
        code: string;
        source: string;
        trustor: string;
      } & BaseOperation;
    }[];
  };
  manageDataByPublicKey: {
    edges: {
      node: {
        dataName: string;
        dataValue: string;
        source: string;
      } & BaseOperation;
    }[];
  };
  beginSponsoringFutureReservesByPublicKey: {
    edges: {
      node: {
        source: string;
      } & BaseOperation;
    }[];
  };
  endSponsoringFutureReservesByPublicKey: {
    edges: {
      node: {
        source: string;
      } & BaseOperation;
    }[];
  };
  revokeSponsorshipByPublicKey: {
    edges: {
      node: {
        source: string;
        sponsorship: string;
      } & BaseOperation;
    }[];
  };
  clawbackByPublicKey: {
    edges: {
      node: {
        amount: string;
        asset: string;
        assetNative: boolean;
        from: string;
        source: string;
      } & BaseOperation;
    }[];
  };
  setTrustLineFlagsByPublicKey: {
    edges: {
      node: {
        asset: string;
        assetNative: boolean;
        clearFlags: boolean;
        setFlags: boolean;
        source: string;
        trustor: string;
      } & BaseOperation;
    }[];
  };
  liquidityPoolDepositByPublicKey: {
    edges: {
      node: {
        maxAmountA: string;
        maxAmountB: string;
        maxPriceD: string;
        maxPriceN: string;
        minPriceD: string;
        source: string;
      } & BaseOperation;
    }[];
  };
  liquidityPoolWithdrawByPublicKey: {
    edges: {
      node: {
        amount: string;
        minAmountA: string;
        minAmountB: string;
        source: string;
      } & BaseOperation;
    }[];
  };
  createClaimableBalanceToPublicKey: {
    edges: {
      node: {
        amount: string;
        asset: string;
        assetNative: boolean;
        source: string;
        claimants: string;
        destinationsPublic: string[];
      } & BaseOperation;
    }[];
  };
  setOptionsByPublicKey: {
    edges: {
      node: {
        clearFlags: number | null;
        setFlags: number | null;
        masterWeight: number | null;
        lowThreshold: number | null;
        medThreshold: number | null;
        highThreshold: number | null;
        homeDomain: string | null;
        signerWeight: number | null;
        signerKind: string;
        signer: string;
        signedPayload: string | null;
      } & BaseOperation;
    }[];
  };
};

const transformAccountHistory = async (
  rawResponse: OperationResult<MercuryAccountHistory>,
  network: NetworkNames,
): Promise<Partial<StellarSdk.Horizon.ServerApi.OperationRecord>[]> => {
  const Sdk = getSdk(StellarSdk.Networks[network]);
  const invokeHostFnEdges =
    rawResponse.data?.invokeHostFnByPublicKey.edges || [];
  const invokeHostFn = invokeHostFnEdges
    .filter((edge) => {
      // we only want to keep these history entries if the Host Fn is
      // for invoking a contract, we dont show contract create or wasm upload in wallet history right now.
      try {
        const hostFn = Sdk.xdr.HostFunction.fromXDR(
          Buffer.from(edge.node.hostFunction, "base64"),
        );
        hostFn.invokeContract();
        return true;
      } catch (error) {
        return false;
      }
    })
    .map((edge) => {
      const baseFields = transformBaseOperation(edge.node, network);
      const hostFn = Sdk.xdr.HostFunction.fromXDR(
        Buffer.from(edge.node.hostFunction, "base64"),
      );

      const invocation = hostFn.invokeContract();
      const fnName = invocation.functionName().toString();

      return {
        ...baseFields,
        type: "invoke_host_function",
        type_i: 24,
        transaction_attr: {
          ...baseFields.transaction_attr,
          contractId: Sdk.StrKey.encodeContract(
            invocation.contractAddress().contractId(),
          ),
          fnName,
          args: getOpArgs(fnName, invocation.args(), network),
          result_meta_xdr: edge.node.sorobanMeta,
        },
      } as Partial<StellarSdk.Horizon.ServerApi.InvokeHostFunctionOperationRecord>;
    });

  const createAccountEdges =
    rawResponse.data?.createAccountByPublicKey.edges || [];
  const createAccount = createAccountEdges.map((edge) => {
    const baseFields = transformBaseOperation(edge.node, network);
    return {
      ...baseFields,
      account: edge.node.destination,
      starting_balance: formatTokenAmount(
        new BigNumber(edge.node.startingBalance),
        7,
      ),
      type: "create_account",
      type_i: 0,
    } as Partial<StellarSdk.Horizon.ServerApi.CreateAccountOperationRecord>;
  });

  const createAccountToEdges =
    rawResponse.data?.createAccountToPublicKey.edges || [];
  const createAccountTo = createAccountToEdges.map((edge) => {
    const baseFields = transformBaseOperation(edge.node, network);
    return {
      ...baseFields,
      account: edge.node.destination,
      starting_balance: formatTokenAmount(
        new BigNumber(edge.node.startingBalance),
        7,
      ),
      type: "create_account",
      type_i: 0,
    } as Partial<StellarSdk.Horizon.ServerApi.CreateAccountOperationRecord>;
  });

  const paymentsByPublicKeyEdges =
    rawResponse.data?.paymentsOfPublicKey.edges || [];
  const paymentsByPublicKey = paymentsByPublicKeyEdges.map((edge) => {
    const baseFields = transformBaseOperation(edge.node, network);
    const code = edge.node.assetByAsset
      ? atob(edge.node.assetByAsset?.code!)
      : null;
    const issuer = edge.node.assetByAsset
      ? edge.node.assetByAsset.issuer
      : null;

    return {
      ...baseFields,
      from: edge.node.source,
      to: edge.node.destination,
      asset_type: code,
      asset_code: code,
      asset_issuer: issuer,
      amount: formatTokenAmount(new BigNumber(edge.node.amount), 7),
      type: "payment",
      type_i: 1,
    } as Partial<StellarSdk.Horizon.ServerApi.PaymentOperationRecord>;
  });

  const pathPaymentsStrictSendByPublicKeyEdges =
    rawResponse.data?.pathPaymentsStrictSendOfPublicKey.nodes || [];
  const pathPaymentsStrictSendByPublicKey =
    pathPaymentsStrictSendByPublicKeyEdges.map((edge) => {
      const baseFields = transformBaseOperation(edge, network);
      const code = edge.destAssetNative
        ? undefined
        : atob(edge.assetByDestAsset.code);
      const transformedFields = {
        ...baseFields,
        type: "path_payment_strict_send",
        type_i: 13,
        asset_type: getAssetType(code),
        source_account: edge.source,
        from: edge.source,
        to: edge.destination,
        destination_min: edge.destMin,
        amount: formatTokenAmount(new BigNumber(edge.sendAmount), 7),
      } as Partial<StellarSdk.Horizon.ServerApi.PathPaymentStrictSendOperationRecord>;

      if (!edge.destAssetNative) {
        transformedFields.asset_code = atob(edge.assetByDestAsset.code);
        transformedFields.asset_issuer = edge.assetByDestAsset.issuer;
      }
      return transformedFields;
    });

  const pathPaymentsStrictReceiveByPublicKeyEdges =
    rawResponse.data?.pathPaymentsStrictReceiveOfPublicKey.nodes || [];
  const pathPaymentsStrictReceiveByPublicKey =
    pathPaymentsStrictReceiveByPublicKeyEdges.map((edge) => {
      const baseFields = transformBaseOperation(edge, network);
      const code = edge.destAssetNative
        ? undefined
        : atob(edge.assetByDestAsset.code);
      const transformedFields = {
        ...baseFields,
        created_at: new Date(
          edge.txInfoByTx.ledgerByLedger.closeTime * 1000,
        ).toISOString(),
        type: "path_payment_strict_receive",
        type_i: 2,
        asset_type: getAssetType(code),
        source_account: edge.source,
        from: edge.source,
        to: edge.destination,
        destination_min: edge.destMin,
        amount: formatTokenAmount(new BigNumber(edge.destAmount), 7),
      } as Partial<StellarSdk.Horizon.ServerApi.PathPaymentOperationRecord>;
      if (!edge.destAssetNative) {
        transformedFields.asset_code = atob(edge.assetByDestAsset.code);
        transformedFields.asset_issuer = edge.assetByDestAsset.issuer;
      }
      return transformedFields;
    });

  const manageBuyOfferByPublicKeyEdges =
    rawResponse.data?.manageBuyOfferByPublicKey.edges || [];
  const manageBuyOfferByPublicKey = manageBuyOfferByPublicKeyEdges.map(
    (edge) => {
      const baseFields = transformBaseOperation(edge.node, network);
      return {
        ...baseFields,
        type: "manage_sell_offer",
        type_i: 4,
      } as Partial<StellarSdk.Horizon.ServerApi.ManageOfferOperationRecord>;
    },
  );

  const manageSellOfferByPublicKeyEdges =
    rawResponse.data?.manageSellOfferByPublicKey.edges || [];
  const manageSellOfferByPublicKey = manageSellOfferByPublicKeyEdges.map(
    (edge) => {
      const baseFields = transformBaseOperation(edge.node, network);
      return {
        ...baseFields,
        type: "manage_sell_offer",
        type_i: 4,
      } as Partial<StellarSdk.Horizon.ServerApi.ManageOfferOperationRecord>;
    },
  );

  const createPassiveSellOfferByPublicKeyEdges =
    rawResponse.data?.createPassiveSellOfferByPublicKey.nodes || [];
  const createPassiveSellOfferByPublicKey =
    createPassiveSellOfferByPublicKeyEdges.map((edge) => {
      const baseFields = transformBaseOperation(edge, network);
      return {
        ...baseFields,
        type: "create_passive_sell_offer",
        type_i: 3,
      } as Partial<StellarSdk.Horizon.ServerApi.PassiveOfferOperationRecord>;
    });

  const changeTrustByPublicKeyEdges =
    rawResponse.data?.changeTrustByPublicKey.nodes || [];
  const changeTrustByPublicKey = changeTrustByPublicKeyEdges.map((edge) => {
    const baseFields = transformBaseOperation(edge, network);
    return {
      ...baseFields,
      type: "change_trust",
      type_i: 6,
    } as Partial<StellarSdk.Horizon.ServerApi.ChangeTrustOperationRecord>;
  });

  const accountMergeByPublicKeyEdges =
    rawResponse.data?.accountMergeByPublicKey.edges || [];
  const accountMergeByPublicKey = accountMergeByPublicKeyEdges.map((edge) => {
    const baseFields = transformBaseOperation(edge.node, network);
    return {
      ...baseFields,
      type: "account_merge",
      type_i: 8,
    } as Partial<StellarSdk.Horizon.ServerApi.AccountMergeOperationRecord>;
  });

  const bumpSequenceByPublicKeyEdges =
    rawResponse.data?.bumpSequenceByPublicKey.edges || [];
  const bumpSequenceByPublicKey = bumpSequenceByPublicKeyEdges.map((edge) => {
    const baseFields = transformBaseOperation(edge.node, network);
    return {
      ...baseFields,
      type: "bump_sequence",
      type_i: 11,
    } as Partial<StellarSdk.Horizon.ServerApi.BumpSequenceOperationRecord>;
  });

  const claimClaimableBalanceByPublicKeyEdges =
    rawResponse.data?.claimClaimableBalanceByPublicKey.edges || [];
  const claimClaimableBalanceByPublicKey =
    claimClaimableBalanceByPublicKeyEdges.map((edge) => {
      const baseFields = transformBaseOperation(edge.node, network);
      return {
        ...baseFields,
        type: "claim_claimable_balance",
        type_i: 15,
      } as Partial<StellarSdk.Horizon.ServerApi.ClaimClaimableBalanceOperationRecord>;
    });

  const createClaimableBalanceByPublicKeyEdges =
    rawResponse.data?.createClaimableBalanceByPublicKey.edges || [];
  const createClaimableBalanceByPublicKey =
    createClaimableBalanceByPublicKeyEdges.map((edge) => {
      const baseFields = transformBaseOperation(edge.node, network);
      return {
        ...baseFields,
        type: "create_claimable_balance",
        type_i: 14,
      } as Partial<StellarSdk.Horizon.ServerApi.CreateClaimableBalanceOperationRecord>;
    });

  const allowTrustByPublicKeyEdges =
    rawResponse.data?.allowTrustByPublicKey.edges || [];
  const allowTrustByPublicKey = allowTrustByPublicKeyEdges.map((edge) => {
    const baseFields = transformBaseOperation(edge.node, network);
    return {
      ...baseFields,
      type: "allow_trust",
      type_i: 7,
    } as Partial<StellarSdk.Horizon.ServerApi.AllowTrustOperationRecord>;
  });

  const manageDataByPublicKeyEdges =
    rawResponse.data?.manageDataByPublicKey.edges || [];
  const manageDataByPublicKey = manageDataByPublicKeyEdges.map((edge) => {
    const baseFields = transformBaseOperation(edge.node, network);
    return {
      ...baseFields,
      type: "manage_data",
      type_i: 10,
    } as Partial<StellarSdk.Horizon.ServerApi.ManageDataOperationRecord>;
  });

  const beginSponsoringFutureReservesByPublicKeyEdges =
    rawResponse.data?.beginSponsoringFutureReservesByPublicKey.edges || [];
  const beginSponsoringFutureReservesByPublicKey =
    beginSponsoringFutureReservesByPublicKeyEdges.map((edge) => {
      const baseFields = transformBaseOperation(edge.node, network);
      return {
        ...baseFields,
        type: "begin_sponsoring_future_reserves",
        type_i: 16,
      } as Partial<StellarSdk.Horizon.ServerApi.BeginSponsoringFutureReservesOperationRecord>;
    });

  const endSponsoringFutureReservesByPublicKeyEdges =
    rawResponse.data?.endSponsoringFutureReservesByPublicKey.edges || [];
  const endSponsoringFutureReservesByPublicKey =
    endSponsoringFutureReservesByPublicKeyEdges.map((edge) => {
      const baseFields = transformBaseOperation(edge.node, network);
      return {
        ...baseFields,
        type: "end_sponsoring_future_reserves",
        type_i: 17,
      } as Partial<StellarSdk.Horizon.ServerApi.EndSponsoringFutureReservesOperationRecord>;
    });

  const revokeSponsorshipByPublicKeyEdges =
    rawResponse.data?.revokeSponsorshipByPublicKey.edges || [];
  const revokeSponsorshipByPublicKey = revokeSponsorshipByPublicKeyEdges.map(
    (edge) => {
      const baseFields = transformBaseOperation(edge.node, network);
      return {
        ...baseFields,
        type: "revoke_sponsorship",
        type_i: 18,
      } as Partial<StellarSdk.Horizon.ServerApi.RevokeSponsorshipOperationRecord>;
    },
  );

  const clawbackByPublicKeyEdges =
    rawResponse.data?.clawbackByPublicKey.edges || [];
  const clawbackByPublicKey = clawbackByPublicKeyEdges.map((edge) => {
    const baseFields = transformBaseOperation(edge.node, network);
    return {
      ...baseFields,
      type: "clawback",
      type_i: 19,
    } as Partial<StellarSdk.Horizon.ServerApi.ClawbackOperationRecord>;
  });

  const setTrustLineFlagsByPublicKeyEdges =
    rawResponse.data?.setTrustLineFlagsByPublicKey.edges || [];
  const setTrustLineFlagsByPublicKey = setTrustLineFlagsByPublicKeyEdges.map(
    (edge) => {
      const baseFields = transformBaseOperation(edge.node, network);
      return {
        ...baseFields,
        type: "set_trust_line_flags",
        type_i: 21,
      } as Partial<StellarSdk.Horizon.ServerApi.SetTrustLineFlagsOperationRecord>;
    },
  );

  const liquidityPoolDepositByPublicKeyEdges =
    rawResponse.data?.liquidityPoolDepositByPublicKey.edges || [];
  const liquidityPoolDepositByPublicKey =
    liquidityPoolDepositByPublicKeyEdges.map((edge) => {
      const baseFields = transformBaseOperation(edge.node, network);
      return {
        ...baseFields,
        type: "liquidity_pool_deposit",
        type_i: 22,
      } as Partial<StellarSdk.Horizon.ServerApi.DepositLiquidityOperationRecord>;
    });

  const liquidityPoolWithdrawByPublicKeyEdges =
    rawResponse.data?.liquidityPoolWithdrawByPublicKey.edges || [];
  const liquidityPoolWithdrawByPublicKey =
    liquidityPoolWithdrawByPublicKeyEdges.map((edge) => {
      const baseFields = transformBaseOperation(edge.node, network);
      return {
        ...baseFields,
        type: "liquidity_pool_withdraw",
        type_i: 23,
      } as Partial<StellarSdk.Horizon.ServerApi.WithdrawLiquidityOperationRecord>;
    });

  const createClaimableBalanceToPublicKeyEdges =
    rawResponse.data?.createClaimableBalanceToPublicKey.edges || [];
  const createClaimableBalanceToPublicKey =
    createClaimableBalanceToPublicKeyEdges.map((edge) => {
      const baseFields = transformBaseOperation(edge.node, network);
      return {
        ...baseFields,
        type: "create_claimable_balance",
        type_i: 14,
        amount: edge.node.amount,
        // This is an VecM<Claimant> from the rust sdk which doesnt seem to have a JS counter part, but we dont use this field yet
        // claimants: edge.node.claimants,
        source_account: edge.node.source,
      } as Partial<StellarSdk.Horizon.ServerApi.CreateClaimableBalanceOperationRecord>;
    });

  const setOptionsToPublicKeyEdges =
    rawResponse.data?.setOptionsByPublicKey.edges || [];
  const setOptionsToPublicKey = setOptionsToPublicKeyEdges.map((edge) => {
    const baseFields = transformBaseOperation(edge.node, network);
    return {
      ...baseFields,
      type: "set_options",
      type_i: 5,
      source_account: edge.node.source,
    } as Partial<StellarSdk.Horizon.ServerApi.SetOptionsOperationRecord>;
  });

  return [
    ...createAccount,
    ...createAccountTo,
    ...createClaimableBalanceToPublicKey,
    ...paymentsByPublicKey,
    ...changeTrustByPublicKey,
    ...allowTrustByPublicKey,
    ...accountMergeByPublicKey,
    ...bumpSequenceByPublicKey,
    ...liquidityPoolDepositByPublicKey,
    ...liquidityPoolWithdrawByPublicKey,
    ...pathPaymentsStrictSendByPublicKey,
    ...pathPaymentsStrictReceiveByPublicKey,
    ...claimClaimableBalanceByPublicKey,
    ...createClaimableBalanceByPublicKey,
    ...manageBuyOfferByPublicKey,
    ...manageSellOfferByPublicKey,
    ...createPassiveSellOfferByPublicKey,
    ...manageDataByPublicKey,
    ...beginSponsoringFutureReservesByPublicKey,
    ...endSponsoringFutureReservesByPublicKey,
    ...revokeSponsorshipByPublicKey,
    ...clawbackByPublicKey,
    ...setTrustLineFlagsByPublicKey,
    ...invokeHostFn,
    ...setOptionsToPublicKey,
  ]
    .filter((tx) => tx.transaction_successful)
    .sort((a, b) => {
      const createdA = a.created_at!;
      const createdB = b.created_at!;
      return new Date(createdB).getTime() - new Date(createdA).getTime();
    }); // Mercury indexes first to last and sort is TODO
};

export {
  transformAccountBalances,
  transformAccountHistory,
  transformAccountBalancesCurrentData,
};
