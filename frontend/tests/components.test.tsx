import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertBanner, BatchStatus, ClaimCard, OrdersTable, PortfolioCard, PrivacyNotice, TradingPanel } from "../components";

afterEach(cleanup);

describe("presentational components", () => {
  it("renders clear empty states without inventing balances or orders", () => {
    render(
      <>
        <OrdersTable orders={[]} />
        <PortfolioCard positions={[]} />
        <ClaimCard claims={[]} />
      </>,
    );
    expect(screen.getByText("No orders yet")).toBeTruthy();
    expect(screen.getByText("No portfolio balances to show")).toBeTruthy();
    expect(screen.getByText("Nothing to claim")).toBeTruthy();
  });

  it("shows the supplied onchain phase and deadline context", () => {
    render(<BatchStatus phase="Reveal" batchId={42} countdownLabel="00:12" countdownValue="12 seconds" helperText="Waiting for reveal deadline." />);
    expect(screen.getByText("Batch 42")).toBeTruthy();
    expect(screen.getByText("Reveal phase")).toBeTruthy();
    expect(screen.getByLabelText("12 seconds")).toBeTruthy();
    expect(screen.getByText("Waiting for reveal deadline.")).toBeTruthy();
  });

  it("uses an accessible alert and invokes dismiss only when requested", () => {
    const dismiss = vi.fn();
    render(<AlertBanner tone="warning" title="Backup required" message="Save your reveal secret." onDismiss={dismiss} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss alert" }));
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("keeps submission disabled until the caller provides a safe action", () => {
    const submit = vi.fn();
    const { rerender } = render(
      <TradingPanel amount="1" limitPrice="3000" side="buy" onSideChange={() => undefined} onAmountChange={() => undefined} onLimitPriceChange={() => undefined} disabledReason="Connect a wallet" />,
    );
    expect(screen.getByRole("button", { name: "Review order" }).hasAttribute("disabled")).toBe(true);
    rerender(
      <TradingPanel amount="1" limitPrice="3000" side="buy" onSideChange={() => undefined} onAmountChange={() => undefined} onLimitPriceChange={() => undefined} onSubmit={submit} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review order" }));
    expect(submit).toHaveBeenCalledOnce();
  });

  it("communicates visibility limits and disables claims without a supported action", () => {
    render(
      <>
        <PrivacyNotice items={["Deposited token and amount are visible onchain.", "Revealed orders are public before settlement."]} />
        <ClaimCard claims={[{ symbol: "USDC", amount: "12.00", available: true }]} />
      </>,
    );
    expect(screen.getByText("Deposited token and amount are visible onchain.")).toBeTruthy();
    expect(screen.getByText("Revealed orders are public before settlement.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Claim 12.00 USDC" }).hasAttribute("disabled")).toBe(true);
  });
});
