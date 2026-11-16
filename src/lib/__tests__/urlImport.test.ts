import { describe, expect, it } from "vitest";
import { fetchPublicFile, isPrivateAddress } from "../urlImport";

describe("isPrivateAddress", () => {
  it("refuses private and reserved IPv4", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8", "2002:808:808::1"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("refuses IPv4 hidden in IPv6, in the hex form URL parsing produces", () => {
    for (const ip of [
      "::1",
      "::",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "::7f00:1",
      "0:0:0:0:0:ffff:7f00:1",
      "::ffff:0:a00:1",
      "64:ff9b::7f00:1",
      "2002:7f00:1::1",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("refuses private IPv6 ranges", () => {
    for (const ip of ["fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "febf::1", "ff02::1", "2001:db8::1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
});

describe("fetchPublicFile", () => {
  it("refuses bracketed IPv6 loopback and metadata addresses before fetching", async () => {
    for (const url of ["http://[::ffff:127.0.0.1]/", "http://[::ffff:169.254.169.254]/latest", "http://[::127.0.0.1]/", "http://0x7f000001/", "http://localhost/"]) {
      await expect(fetchPublicFile(url), url).rejects.toMatchObject({ message: "That address isn't on the public internet" });
    }
  });
});
