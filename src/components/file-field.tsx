"use client";

import { useState } from "react";
import { tr } from "@/lib/i18n";

// ファイルの選択欄。ブラウザ標準の表示（「ファイルを選択」など）はブラウザの言語で出るため、隠して自前のボタンと選んだファイル名を出す
export function FileField({ name, accept }: { name: string; accept: string }) {
  const [fileName, setFileName] = useState<string | null>(null);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="rounded-lg border border-line-input bg-surface px-3 py-1.5 text-sm">{tr("ファイルを選ぶ", "Choose file")}</span>
      <span className="truncate text-sm text-ink-sub">{fileName ?? tr("選ばれていません", "No file chosen")}</span>
      <input name={name} type="file" accept={accept} onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)} className="sr-only" />
    </span>
  );
}
