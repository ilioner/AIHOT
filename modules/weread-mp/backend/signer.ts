// WeRead's request signature (weread::GenSignature): every part is remapped byte by byte through the
// client library's S-box, a fixed salt is added, the parts are sorted as byte strings, concatenated,
// then two rounds of xor-summed rotation and SHA-256. The refresh-token exchange is the only caller
// that needs it; a long-lived token is signed once per refresh, not per article.
import { createHash, randomBytes, randomUUID } from "node:crypto";

const SBOX = new Uint8Array([
  52, 202, 85, 64, 29, 182, 147, 198, 49, 48, 41, 53, 50, 167, 184, 17,
  194, 181, 22, 250, 139, 177, 36, 164, 16, 144, 4, 233, 8, 248, 59, 138,
  156, 140, 68, 249, 188, 92, 105, 226, 161, 218, 210, 211, 117, 137, 247, 30,
  45, 80, 86, 215, 114, 83, 191, 34, 251, 32, 15, 1, 46, 69, 135, 110,
  102, 72, 242, 224, 205, 254, 103, 169, 67, 244, 148, 81, 206, 165, 74, 238,
  19, 38, 142, 204, 170, 51, 20, 93, 14, 57, 187, 207, 145, 43, 129, 77,
  234, 153, 236, 26, 44, 133, 197, 217, 54, 116, 75, 24, 225, 241, 61, 157,
  65, 159, 180, 23, 13, 214, 76, 190, 220, 175, 151, 40, 119, 240, 98, 255,
  113, 193, 200, 39, 143, 108, 104, 168, 155, 230, 89, 28, 27, 18, 9, 152,
  78, 63, 6, 55, 0, 186, 31, 10, 25, 47, 201, 213, 208, 87, 73, 111,
  253, 37, 228, 97, 12, 66, 203, 150, 100, 95, 219, 173, 96, 35, 141, 154,
  109, 195, 196, 94, 62, 185, 146, 106, 189, 91, 7, 127, 118, 149, 237, 79,
  171, 132, 122, 128, 231, 120, 199, 229, 235, 115, 131, 107, 252, 56, 70, 125,
  71, 101, 179, 82, 99, 58, 5, 209, 239, 163, 166, 222, 158, 60, 2, 174,
  178, 123, 160, 246, 243, 42, 192, 172, 134, 3, 90, 84, 11, 245, 130, 212,
  126, 227, 223, 176, 216, 221, 33, 232, 124, 136, 162, 121, 88, 112, 183, 21,
]);

const SALT = Buffer.from("5a6f1", "utf8");

function remap(value: string): Buffer {
  const raw = Buffer.from(value, "utf8");
  const out = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = SBOX[raw[i]]!;
  return out;
}

function rotate(input: Buffer, shift: number): Buffer {
  const n = input.length;
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[(i + shift) % n] = input[i]!;
  return out;
}

function xorSum(input: Buffer): number {
  let sum = 0;
  for (const byte of input) sum ^= byte;
  return sum;
}

/** The signature for a token refresh: the parts as the client sends them, in that order. */
export function genSignature(parts: readonly string[]): string {
  const items = parts.map(remap);
  items.push(SALT);
  items.sort(Buffer.compare);
  const joined = Buffer.concat(items);
  if (joined.length === 0) return "";
  const first = rotate(joined, xorSum(joined) % 11);
  const hash = Buffer.from(createHash("sha256").update(first).digest("hex"), "ascii");
  return createHash("sha256").update(rotate(hash, xorSum(hash) % 11)).digest("hex");
}

/** The anti-replay signature the QR login sends with a code: sha256 of timestamp, device and random. */
export function antiReplaySignature(deviceId: string, timestamp: number, random: number): string {
  return createHash("sha256").update(`${timestamp}${deviceId}${random}`, "utf8").digest("hex");
}

export interface DeviceProfile {
  deviceId: string;
  deviceName: string;
  installId: string;
  userAgent: string;
}

const DEVICE_NAMES = [
  "Xiaomi 14", "Xiaomi 14 Pro", "Xiaomi 13", "Redmi K70 Pro", "HUAWEI Mate 60 Pro",
  "HUAWEI Pura 70 Pro", "vivo X100", "vivo X90 Pro", "OPPO Find X7", "OPPO Reno11 Pro",
  "Honor Magic6 Pro", "OnePlus 12", "Samsung Galaxy S24", "Samsung Galaxy S23",
];

/** A device identity for one login, kept with the account so every later refresh signs as the same device. */
export function newDeviceProfile(): DeviceProfile {
  const deviceId = createHash("md5").update(randomBytes(16)).digest("hex");
  return {
    deviceId,
    deviceName: DEVICE_NAMES[Math.floor(Math.random() * DEVICE_NAMES.length)]!,
    installId: randomUUID(),
    userAgent: "WeRead/7.5.0 (Android; 33; arm64-v8a)",
  };
}
