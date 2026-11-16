import type { Metadata } from 'next';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { ConfigHydrator } from '@/components/ConfigHydrator';
import { PRODUCT_COPY } from '@/lib/product-copy';
import './globals.css';

export const metadata: Metadata = {
  title: `${PRODUCT_COPY.appName} · ${PRODUCT_COPY.workspaceName}`,
  description: '管理素材、研究选题、生成内容并记录发布结果。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen overflow-x-hidden bg-[#FDF8F3] antialiased">
        <ConfigHydrator />
        <DashboardLayout>{children}</DashboardLayout>
      </body>
    </html>
  );
}
