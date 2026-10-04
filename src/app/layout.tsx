import type { Metadata, Viewport } from "next";
import "./globals.css";
import { isEn, tr } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Yadori",
  description: tr("ホテル運営AIエージェント", "The AI teammate for hotel operations"),
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#F5F3EE",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // ブラウザ拡張が <html> に属性を足すことによるハイドレーション警告を抑える（この要素の属性のみ対象）
    <html lang={isEn ? "en" : "ja"} className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
