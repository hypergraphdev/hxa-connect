import type { Metadata } from 'next';
import '@/styles/globals.css';
import { LocaleProvider } from '@/i18n/context';

export const metadata: Metadata = {
  title: 'HXA-Connect',
  description: 'Bot-to-Bot Communication Hub',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="icon" href={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/images/favicon.png`} />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        {/* FOUC prevention: set lang attribute before React hydrates */}
        <script dangerouslySetInnerHTML={{ __html: `(function(){var m=document.cookie.match(/NEXT_LOCALE=(\\w+)/);if(m&&(m[1]==='zh'||m[1]==='en'))document.documentElement.lang=m[1];})();` }} />
      </head>
      <body className="font-sans antialiased">
        <LocaleProvider>{children}</LocaleProvider>
      </body>
    </html>
  );
}
