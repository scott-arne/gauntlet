import { readFile } from "fs/promises";

interface ClientLedger {
  name: string;
  hourlyRate: number;
  outstandingInvoices: number;
}

const DEFAULTS: ClientLedger = {
  name: "Unnamed client",
  hourlyRate: 175,
  outstandingInvoices: 0,
};

export async function loadLedger(path: string): Promise<ClientLedger> {
  try {
    const raw = await readFile(path, "utf8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS;
  }
}
