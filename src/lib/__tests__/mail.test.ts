// Email pieces that run outside the database: the Markdown renderer used for
// automation emails (and their preview), SendGrid's webhook signature check,
// and the editor's tag helpers.
import { describe, expect, it } from "vitest";
import { plainText, renderHtml } from "../../../supabase/functions/_shared/markdown";
import { derToRaw, verifySendGridSignature } from "../../../supabase/functions/_shared/sgverify";
import { columnTags, insertTag, tagsIn, unknownTag } from "../mailTags";
import type { DocColumn } from "../types";

describe("markdown for emails", () => {
  it("renders paragraphs, emphasis, links and lists", () => {
    const html = renderHtml("Hello **Ann**,\nyour *order* is ready.\n\n- one\n- two\n\n1. first\n2. second\n\n[Open it](https://app.example.com/doc/1?record=t:5)");
    expect(html).toContain("<p>Hello <strong>Ann</strong>,<br>your <em>order</em> is ready.</p>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
    expect(html).toContain('<a href="https://app.example.com/doc/1?record=t:5">Open it</a>');
  });

  it("links bare addresses without swallowing the full stop", () => {
    expect(renderHtml("See https://example.com/a_b_c.")).toBe('<p>See <a href="https://example.com/a_b_c">https://example.com/a_b_c</a>.</p>');
  });

  it("renders headings one level down", () => {
    expect(renderHtml("# Title\ntext")).toBe("<h2>Title</h2>\n<p>text</p>");
  });

  it("never lets through HTML", () => {
    const html = renderHtml('<script>alert(1)</script> <img src=x onerror="x"> [x](javascript:alert(1))');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript');
    expect(html).toContain("&lt;script&gt;");
  });

  it("keeps escaped values literal: a cell can't add formatting or a link", () => {
    const filled = "Hi A\\*b\\* \\[x\\]\\(http://evil.example\\) and \\_y\\_";
    const html = renderHtml(filled);
    expect(html).toBe("<p>Hi A*b* [x](http://evil.example) and _y_</p>");
    expect(plainText(filled)).toBe("Hi A*b* [x](http://evil.example) and _y_");
  });

  it("doesn't read snake_case or maths as emphasis", () => {
    expect(renderHtml("total_amount_due is 2 * 3 * 4")).toBe("<p>total_amount_due is 2 * 3 * 4</p>");
  });
});

describe("SendGrid webhook signature", () => {
  // Builds what SendGrid sends: an ECDSA P-256 signature over timestamp + body, DER-encoded, base64.
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  const rawToDer = (raw: Uint8Array) => {
    const int = (v: Uint8Array) => {
      let i = 0;
      while (i < v.length - 1 && v[i] === 0) i++;
      let body = v.subarray(i);
      if (body[0] & 0x80) body = Uint8Array.from([0, ...body]);
      return Uint8Array.from([0x02, body.length, ...body]);
    };
    const r = int(raw.subarray(0, 32));
    const s = int(raw.subarray(32));
    return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
  };
  const signed = async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const body = new TextEncoder().encode('[{"event":"delivered","email":"ann@example.com","lmdu_env":"lmdu"}]\r\n');
    const timestamp = "1795000000";
    const payload = Uint8Array.from([...new TextEncoder().encode(timestamp), ...body]);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, payload));
    const publicKey = b64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
    return { publicKey, signature: b64(rawToDer(raw)), timestamp, body, raw };
  };

  it("accepts a correctly signed request", async () => {
    const s = await signed();
    expect(await verifySendGridSignature(s.publicKey, s.signature, s.timestamp, s.body)).toBe(true);
    expect(await verifySendGridSignature(`-----BEGIN PUBLIC KEY-----\n${s.publicKey}\n-----END PUBLIC KEY-----`, s.signature, s.timestamp, s.body)).toBe(true);
  });

  it("refuses a changed body, timestamp, key or a missing signature", async () => {
    const s = await signed();
    const other = await signed();
    const changed = Uint8Array.from(s.body);
    changed[10] ^= 1;
    expect(await verifySendGridSignature(s.publicKey, s.signature, s.timestamp, changed)).toBe(false);
    expect(await verifySendGridSignature(s.publicKey, s.signature, "1795000001", s.body)).toBe(false);
    expect(await verifySendGridSignature(other.publicKey, s.signature, s.timestamp, s.body)).toBe(false);
    expect(await verifySendGridSignature(s.publicKey, "", s.timestamp, s.body)).toBe(false);
    expect(await verifySendGridSignature(s.publicKey, "not base64 !!", s.timestamp, s.body)).toBe(false);
    expect(await verifySendGridSignature("", s.signature, s.timestamp, s.body)).toBe(false);
  });

  it("converts DER signatures back to r || s", async () => {
    const s = await signed();
    expect(derToRaw(rawToDer(s.raw))).toEqual(s.raw);
    expect(derToRaw(Uint8Array.from([1, 2, 3]))).toBeNull();
  });
});

describe("tags in the editor", () => {
  const col = (id: string, table: string, col_id: string, label: string, type: DocColumn["type"] = "Text", options = {}): DocColumn => ({
    id, doc_id: "d", table_ref: table, col_id, label, type, is_formula: false, formula: "", options, position: 0,
  });
  const leads = [col("1", "leads", "Email", "Email"), col("2", "leads", "FullName", "Full name"), col("3", "leads", "Owner", "Owner", "Ref", { refTable: "people" })];
  const people = [col("4", "people", "Name", "Name")];
  const columnsOf = (t: string) => (t === "people" ? people : t === "leads" ? leads : []);

  it("reads tags with spaces and fallbacks", () => {
    expect(tagsIn("Hi {{ FullName | there }} {{id}}")).toEqual([
      { name: "FullName", fallback: " there " },
      { name: "id", fallback: null },
    ]);
  });

  it("offers columns and fields through references", () => {
    const t = columnTags(leads, columnsOf);
    expect(t.columns.map((x) => x.name)).toEqual(["Email", "FullName", "Owner"]);
    expect(t.references).toEqual([{ name: "Owner.Name", label: "Owner → Name" }]);
  });

  it("finds the first unknown tag, as the database does", () => {
    expect(unknownTag("{{Email}} {{Full name}} {{Owner.Name}} {{Owner.id}} {{record_link}} {{LINK}} {{changed_by}}", leads, columnsOf)).toBeNull();
    expect(unknownTag("Hi {{Nmae}}", leads, columnsOf)).toBe("Nmae");
    expect(unknownTag("{{Owner.Phone}}", leads, columnsOf)).toBe("Owner.Phone");
    expect(unknownTag("{{Email.Name}}", leads, columnsOf)).toBe("Email.Name");
  });

  it("inserts at the cursor or over a selection", () => {
    expect(insertTag("Hello !", "FullName", 6, 6)).toEqual({ text: "Hello {{FullName}}!", cursor: 18 });
    expect(insertTag("Hello NAME!", "FullName", 6, 10)).toEqual({ text: "Hello {{FullName}}!", cursor: 18 });
    expect(insertTag("Hi", "id", null, null)).toEqual({ text: "Hi{{id}}", cursor: 8 });
  });
});
