import type { Metadata, Viewport } from "next";
import { Shippori_Mincho_B1, Zen_Kaku_Gothic_New } from "next/font/google";
import "./globals.css";

// 見出しのホテル名は明朝、それ以外はゴシック（docs/ui-mock/README.md「デザインの基本」）
const mincho = Shippori_Mincho_B1({
  variable: "--font-mincho",
  weight: "600",
  subsets: ["latin"],
  preload: false,
});

const gothic = Zen_Kaku_Gothic_New({
  variable: "--font-gothic",
  weight: ["400", "500", "700"],
  subsets: ["latin"],
  preload: false,
});

export const metadata: Metadata = {
  title: "Hotel Agent",
  description: "ホテル運営AIエージェント",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#F5F3EE",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // ブラウザ拡張が <html> に属性を足すことによるハイドレーション警告を抑える（この要素の属性のみ対象）
    <html lang="ja" className={`${mincho.variable} ${gothic.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
