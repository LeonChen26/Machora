"use client";

import { useState } from "react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用时静默失败
    }
  }

  return (
    <button
      type="button"
      className="btn"
      onClick={copy}
      style={{ padding: "0.15rem 0.5rem", fontSize: 11 }}
    >
      {copied ? "已复制 ✓" : "复制"}
    </button>
  );
}
