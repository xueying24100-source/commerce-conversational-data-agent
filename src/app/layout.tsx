import './globals.css'
import type { Metadata } from 'next'
import { ThemeProvider } from '@/contexts/ThemeContext'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: {
    default: 'Commerce Conversational Data Agent',
    template: '%s',
  },
  description: '连接真实 PostgreSQL 经营数据的多轮电商 Data Agent，回答附带可追溯 Evidence。',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var m=localStorage.getItem('commerce-agent-color-mode')==='dark'?'dark':'light';document.documentElement.classList.toggle('dark',m==='dark');document.documentElement.style.colorScheme=m;}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-screen bg-background text-foreground">
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
