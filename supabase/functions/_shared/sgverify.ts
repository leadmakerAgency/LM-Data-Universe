// Checks the signature SendGrid puts on Event Webhook requests
// (Settings → Mail Settings → Event Webhook → Signed Event Webhook).
//
//   X-Twilio-Email-Event-Webhook-Signature   base64 of an ECDSA (P-256, SHA-256) signature in DER form
//   X-Twilio-Email-Event-Webhook-Timestamp   signed together with the raw request body: timestamp + body
//
// The public key is the base64 text SendGrid shows next to the setting.
// Pure Web Crypto, so the app's unit tests can run it too.

function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** DER `SEQUENCE { INTEGER r, INTEGER s }` to the fixed-size r || s that Web Crypto verifies. */
export function derToRaw(der: Uint8Array, size = 32): Uint8Array | null {
  let i = 0;
  if (der[i++] !== 0x30) return null;
  if (der[i] & 0x80) i += 1 + (der[i] & 0x7f);
  else i++;
  const out = new Uint8Array(size * 2);
  for (let part = 0; part < 2; part++) {
    if (der[i++] !== 0x02) return null;
    const len = der[i++];
    if (len === undefined || len & 0x80 || i + len > der.length) return null;
    let v = der.subarray(i, i + len);
    i += len;
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) return null;
    out.set(v, part * size + (size - v.length));
  }
  return out;
}

export async function verifySendGridSignature(publicKey: string, signature: string, timestamp: string, body: Uint8Array): Promise<boolean> {
  try {
    if (!publicKey || !signature || !timestamp) return false;
    const raw = derToRaw(fromBase64(signature));
    if (!raw) return false;
    const key = await crypto.subtle.importKey("spki", fromBase64(publicKey) as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ts = new TextEncoder().encode(timestamp);
    const signed = new Uint8Array(ts.length + body.length);
    signed.set(ts, 0);
    signed.set(body, ts.length);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw as BufferSource, signed as BufferSource);
  } catch {
    return false;
  }
}
