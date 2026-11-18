export type Tone = "neutral" | "positive" | "warning" | "danger";

export type Order = {
  id: string;
  side: "Buy" | "Sell";
  amount: string;
  limitPrice: string;
  status: string;
  submittedAt?: string;
  commitTx?: string;
  commitTxUrl?: string;
  revealTx?: string;
  revealTxUrl?: string;
  executionSummary?: string;
};

export type Position = {
  symbol: string;
  amount: string;
  /** Optional caller-supplied secondary value, such as a claimable amount. */
  detail?: string;
};

export type Claim = {
  symbol: string;
  amount: string;
  available?: boolean;
};
