import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "Inter, sans-serif", background: "#07090f", color: "#f4f6fb" }}>
        {children}
      </body>
    </html>
  );
}
