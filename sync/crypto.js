// データ暗号化ユーティリティ（サイトのパスワード保護用）。
// Web側 assets/app.js の decryptJson と同じフォーマット:
// { __enc:1, alg:"A256GCM", kdf:"PBKDF2-SHA256", iter, salt, iv, ct }  (salt/iv/ct はbase64)
import { webcrypto } from "node:crypto";

const ITER = 150000;

async function deriveKey(password, salt) {
  const base = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return webcrypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

const b64 = (buf) => Buffer.from(buf).toString("base64");
const unb64 = (str) => new Uint8Array(Buffer.from(str, "base64"));

export async function encryptJson(obj, password) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(obj))
  );
  return {
    __enc: 1,
    alg: "A256GCM",
    kdf: "PBKDF2-SHA256",
    iter: ITER,
    salt: b64(salt),
    iv: b64(iv),
    ct: b64(ct),
  };
}

export async function decryptJson(payload, password) {
  const key = await deriveKey(password, unb64(payload.salt));
  const pt = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(payload.iv) },
    key,
    unb64(payload.ct)
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

export function isEncrypted(obj) {
  return !!(obj && obj.__enc === 1 && obj.ct);
}
