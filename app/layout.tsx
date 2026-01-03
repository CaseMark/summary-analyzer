import type { Metadata } from 'next';
import { ThemeProvider } from '@/components/theme-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/toaster';
import { DebugConsole } from '@/components/debug-console';
import Link from 'next/link';
import {
  Scale,
  Home,
  Plus,
  BarChart3,
  FileText,
  Github,
  ExternalLink,
  Star,
} from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { TEST_MODELS, CONTROL_MODEL } from '@/lib/types';
import './globals.css';

export const metadata: Metadata = {
  title: 'Summary Analyzer | case.dev',
  description:
    'Compare AI-generated legal document summaries across multiple LLM models. Evaluate factual accuracy, citation precision, and legal utility.',
  icons: {
    icon: '/favicon.svg',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=JetBrains+Mono:wght@400;500&family=Playfair+Display:wght@500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem={false}
          disableTransitionOnChange
        >
          <TooltipProvider>
            <div className="flex h-screen bg-background">
              {/* Sidebar */}
              <aside className="w-64 border-r border-border bg-card/50 flex flex-col">
                {/* Logo Header */}
                <div className="p-5 border-b border-border">
                  <Link href="/" className="flex items-center gap-3 group">
                    <div className="p-2 rounded-lg bg-primary/10 group-hover:bg-primary/20 transition-colors">
                      <Scale className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <span className="font-serif text-lg font-semibold">
                        Summary Analyzer
                      </span>
                      <span className="block text-[10px] text-muted-foreground uppercase tracking-wider">
                        by case.dev
                      </span>
                    </div>
                  </Link>
                </div>

                <nav className="flex-1 overflow-y-auto p-3">
                  <div className="space-y-1">
                    <Link
                      href="/"
                      className="flex items-center gap-3 px-3 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
                    >
                      <Home className="h-4 w-4" />
                      <span>Dashboard</span>
                    </Link>
                    <Link
                      href="/new"
                      className="flex items-center gap-3 px-3 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
                    >
                      <Plus className="h-4 w-4" />
                      <span>New Comparison</span>
                    </Link>
                    <Link
                      href="/analytics"
                      className="flex items-center gap-3 px-3 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
                    >
                      <BarChart3 className="h-4 w-4" />
                      <span>Analytics</span>
                    </Link>
                  </div>

                  <Separator className="my-4" />

                  <div className="space-y-1">
                    <div className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                      Models Tested ({TEST_MODELS.length})
                    </div>
                    <div className="px-3 py-1.5 text-xs text-muted-foreground space-y-0.5">
                      {TEST_MODELS.map((model) => {
                        const controlCost = CONTROL_MODEL.inputPricePer1M + CONTROL_MODEL.outputPricePer1M;
                        const modelCost = model.inputPricePer1M + model.outputPricePer1M;
                        const costDiff = Math.round(((modelCost - controlCost) / controlCost) * 100);
                        
                        return (
                          <div key={model.id} className="flex items-center gap-2 py-0.5">
                            {model.isControl ? (
                              <Star className="w-2.5 h-2.5 text-amber-400 fill-amber-400" />
                            ) : (
                              <div 
                                className="w-2 h-2 rounded-full" 
                                style={{ backgroundColor: model.color }}
                              />
                            )}
                            <span className={model.isControl ? 'text-amber-400 font-medium' : ''}>
                              {model.name.replace('⭐ ', '')}
                            </span>
                            {!model.isControl && costDiff !== 0 && (
                              <span className={`text-[9px] ${costDiff < 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                {costDiff > 0 ? '+' : ''}{costDiff}%
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <Separator className="my-4" />

                  <div className="space-y-1">
                    <div className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                      Resources
                    </div>
                    <a
                      href="https://docs.case.dev"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-3 px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
                    >
                      <FileText className="h-4 w-4" />
                      <span>API Docs</span>
                      <ExternalLink className="h-3 w-3 ml-auto opacity-50" />
                    </a>
                    <a
                      href="https://github.com/casemarkai"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-3 px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
                    >
                      <Github className="h-4 w-4" />
                      <span>GitHub</span>
                      <ExternalLink className="h-3 w-3 ml-auto opacity-50" />
                    </a>
                  </div>
                </nav>

                {/* Footer */}
                <div className="p-4 border-t border-border">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <BarChart3 className="h-3.5 w-3.5" />
                    <span>Judge Model: GPT-5.2</span>
                  </div>
                </div>
              </aside>

              {/* Main Content */}
              <main className="flex-1 overflow-y-auto">{children}</main>
            </div>
            <Toaster />
            <DebugConsole />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}


