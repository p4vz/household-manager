"use client";

/**
 * Web Bluetooth driver for 58 mm ESC/POS BLE receipt printers (Chrome on
 * Android, including the DeX kiosk, and desktop Chrome/Edge). Safari and
 * iOS have no Web Bluetooth; callers fall back to the print preview.
 *
 * Most cheap printers expose service 0x18F0 with write characteristic
 * 0x2AF1. Others use vendor services, so after connecting we fall back to
 * the first characteristic on any known service that accepts writes.
 */
import { toEscPos, type ReceiptLine } from "./receipt";

export const PRINTER_SERVICE = "000018f0-0000-1000-8000-00805f9b34fb";
const PRINTER_CHARACTERISTIC = "00002af1-0000-1000-8000-00805f9b34fb";

/** Services seen on common 58 mm BLE printers, tried after 0x18F0. */
const FALLBACK_SERVICES = [
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
  "49535343-fe7d-4ae5-8fa9-9fafd205e455",
  "0000ff00-0000-1000-8000-00805f9b34fb",
  "0000ffe0-0000-1000-8000-00805f9b34fb",
  "0000fee7-0000-1000-8000-00805f9b34fb",
];

/** BLE writes are small; 100 bytes with a short pause keeps cheap printers from dropping data. */
const CHUNK = 100;
const CHUNK_DELAY_MS = 20;

// Minimal Web Bluetooth types (not in TypeScript's DOM lib).
type Characteristic = {
  uuid: string;
  properties: { write: boolean; writeWithoutResponse: boolean };
  writeValueWithoutResponse?(v: BufferSource): Promise<void>;
  writeValueWithResponse?(v: BufferSource): Promise<void>;
  writeValue(v: BufferSource): Promise<void>;
};
type Service = { uuid: string; getCharacteristics(): Promise<Characteristic[]> };
type Server = { connected: boolean; connect(): Promise<Server>; getPrimaryServices(): Promise<Service[]> };
type Device = { name?: string; gatt?: Server; addEventListener(t: string, f: () => void): void };
type Bluetooth = {
  getAvailability?(): Promise<boolean>;
  requestDevice(opts: unknown): Promise<Device>;
};

function bluetooth(): Bluetooth | null {
  if (typeof navigator === "undefined") return null;
  return (navigator as unknown as { bluetooth?: Bluetooth }).bluetooth ?? null;
}

export function isBluetoothPrintingSupported(): boolean {
  return bluetooth() !== null && typeof window !== "undefined" && window.isSecureContext;
}

let device: Device | null = null;
let writer: Characteristic | null = null;

export function connectedPrinterName(): string | null {
  return device?.gatt?.connected ? (device.name ?? "Printer") : null;
}

async function findWriter(server: Server): Promise<Characteristic> {
  const services = await server.getPrimaryServices();
  const ordered = [
    ...services.filter((s) => s.uuid === PRINTER_SERVICE),
    ...services.filter((s) => s.uuid !== PRINTER_SERVICE),
  ];
  for (const service of ordered) {
    const chars = await service.getCharacteristics();
    const preferred = chars.find((c) => c.uuid === PRINTER_CHARACTERISTIC);
    if (preferred) return preferred;
    const writable = chars.find((c) => c.properties.writeWithoutResponse || c.properties.write);
    if (writable) return writable;
  }
  throw new Error("This Bluetooth device has no printer channel. Is it the receipt printer?");
}

/**
 * Asks the browser to pick a printer (must run from a tap). Printers that
 * advertise 0x18F0 are listed first; the "show all" path lists every
 * nearby device for printers that advertise nothing useful.
 */
export async function pairPrinter(opts: { showAll?: boolean } = {}): Promise<string> {
  const bt = bluetooth();
  if (!bt) throw new Error("Bluetooth printing needs Chrome on Android or a desktop.");
  const optionalServices = [PRINTER_SERVICE, ...FALLBACK_SERVICES];
  device = await bt.requestDevice(
    opts.showAll
      ? { acceptAllDevices: true, optionalServices }
      : { filters: [{ services: [PRINTER_SERVICE] }, ...["MTP", "PT-", "RPP", "MPT", "Printer", "BlueTooth Printer", "PeriPage", "GT01"].map((namePrefix) => ({ namePrefix }))], optionalServices },
  );
  device.addEventListener("gattserverdisconnected", () => {
    writer = null;
  });
  await ensureConnected();
  return device.name ?? "Printer";
}

async function ensureConnected(): Promise<Characteristic> {
  if (!device?.gatt) throw new Error("No printer paired yet.");
  if (writer && device.gatt.connected) return writer;
  const server = await device.gatt.connect();
  writer = await findWriter(server);
  return writer;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function sendBytes(data: Uint8Array): Promise<void> {
  const ch = await ensureConnected();
  for (let i = 0; i < data.length; i += CHUNK) {
    const part = data.slice(i, i + CHUNK);
    if (ch.properties.writeWithoutResponse && ch.writeValueWithoutResponse) await ch.writeValueWithoutResponse(part);
    else if (ch.writeValueWithResponse) await ch.writeValueWithResponse(part);
    else await ch.writeValue(part);
    await sleep(CHUNK_DELAY_MS);
  }
}

/** Prints a receipt, pairing first if needed. */
export async function printReceipt(lines: ReceiptLine[]): Promise<void> {
  if (!device) await pairPrinter();
  await sendBytes(toEscPos(lines));
}
