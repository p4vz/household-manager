import { describe, expect, it } from "vitest";
import { accountFamily, familyFromActivity, guessAccountKind, inferAccountKind, kindsCompatible } from "@/modules/finance/ingest/account-kind";

const bankTxns = [
  { amount: 2500, description: "PAYROLL DIRECT DEP" },
  { amount: -200, description: "ATM WITHDRAWAL" },
  { amount: -80, description: "ZELLE TO SOMEONE" },
  { amount: -40, description: "Grocery Store" },
];
const cardTxns = [
  { amount: 1200, description: "ONLINE PAYMENT - THANK YOU" },
  { amount: 900, description: "AUTOPAY PAYMENT - THANK YOU" },
  { amount: -14.2, description: "INTEREST CHARGE ON PURCHASES" },
  { amount: -40, description: "Grocery Store" },
];

describe("account types", () => {
  it("guesses from the bank's name, explicit checking or savings first", () => {
    expect(guessAccountKind("Wells Fargo Everyday Checking")).toBe("checking");
    expect(guessAccountKind("Way2Save Savings")).toBe("savings");
    expect(guessAccountKind("Initiate Business Checking")).toBe("business_checking");
    expect(guessAccountKind("Business Platinum Credit Card")).toBe("business_credit");
    expect(guessAccountKind("Active Cash Visa Signature Card")).toBe("credit");
    expect(guessAccountKind("Checking with debit card")).toBe("checking");
    expect(guessAccountKind("Wells Fargo Joint")).toBe("other");
  });

  it("tells bank accounts from cards by their activity", () => {
    expect(familyFromActivity(bankTxns)).toBe("bank");
    expect(familyFromActivity(cardTxns)).toBe("card");
    expect(familyFromActivity([{ amount: -5, description: "Coffee" }])).toBeNull();
    // A card payment leaving checking is not a card signal.
    expect(familyFromActivity([...bankTxns, { amount: -900, description: "WF CREDIT CARD AUTO PAY" }])).toBe("bank");
  });

  it("uses activity when the name is silent or wrong", () => {
    expect(inferAccountKind("Wells Fargo Joint", bankTxns)).toBe("checking");
    expect(inferAccountKind("Wells Fargo Business", bankTxns)).toBe("business_checking");
    expect(inferAccountKind("Wells Fargo Business", cardTxns)).toBe("business_credit");
    expect(inferAccountKind("Wells Fargo Way2Save", bankTxns)).toBe("savings");
    expect(inferAccountKind("Home Mortgage", cardTxns)).toBe("loan");
    expect(inferAccountKind("Wells Fargo Joint", [])).toBe("other");
  });

  it("never pairs a bank account with a card", () => {
    expect(kindsCompatible("checking", "credit")).toBe(false);
    expect(kindsCompatible("savings", "business_credit")).toBe(false);
    expect(kindsCompatible("business_checking", "checking")).toBe(true);
    expect(kindsCompatible("other", "credit")).toBe(true);
    expect(accountFamily("other")).toBeNull();
  });
});
