'use client';

import { useState, useEffect, useRef } from 'react';
import { debugLogger, type LogEntry } from '@/lib/debug-logger';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { 
  Terminal, 
  X, 
  Trash2, 
  ChevronDown, 
  ChevronUp,
  Copy,
  CheckCheck
} from 'lucide-react';

export function DebugConsole() {
  const [isOpen, setIsOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Get initial logs
    setLogs(debugLogger.getLogs());
    
    // Subscribe to updates
    const unsubscribe = debugLogger.subscribe(setLogs);
    return unsubscribe;
  }, []);

  const copyLogs = async () => {
    const logText = logs.map(log => {
      const time = log.timestamp.toLocaleTimeString();
      const data = log.data ? `\n  Data: ${JSON.stringify(log.data, null, 2)}` : '';
      return `[${time}] [${log.level.toUpperCase()}] [${log.source || 'app'}] ${log.message}${data}`;
    }).join('\n\n');
    
    await navigator.clipboard.writeText(logText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const copyAllErrors = async () => {
    const errorLogs = logs.filter(l => l.level === 'error' || l.level === 'warn');
    if (errorLogs.length === 0) {
      return;
    }
    
    const errorText = `## ${errorLogs.length} Error(s)/Warning(s) from Summary Analyzer Debug Console\n\n` + 
      errorLogs.map((log, idx) => {
        const time = log.timestamp.toLocaleTimeString();
        const data = log.data ? `\nData: ${JSON.stringify(log.data, null, 2)}` : '';
        return `### Error ${idx + 1}/${errorLogs.length}\n**Time:** ${time}\n**Level:** ${log.level.toUpperCase()}\n**Source:** ${log.source || 'app'}\n**Message:** ${log.message}${data}`;
      }).join('\n\n---\n\n');
    
    await navigator.clipboard.writeText(errorText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const errorCount = logs.filter(l => l.level === 'error').length;
  const warnCount = logs.filter(l => l.level === 'warn').length;

  if (!isOpen) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsOpen(true)}
        className={cn(
          "fixed bottom-4 right-4 z-50 gap-2",
          errorCount > 0 && "border-red-500/50 text-red-400"
        )}
      >
        <Terminal className="w-4 h-4" />
        Debug
        {errorCount > 0 && (
          <Badge variant="destructive" className="h-5 px-1.5 text-xs">
            {errorCount}
          </Badge>
        )}
        {warnCount > 0 && errorCount === 0 && (
          <Badge className="h-5 px-1.5 text-xs bg-amber-500/20 text-amber-400 border-amber-500/50">
            {warnCount}
          </Badge>
        )}
      </Button>
    );
  }

  return (
    <div
      className={cn(
        "fixed z-50 bg-[#0a0a12] border border-border rounded-lg shadow-2xl transition-all duration-200",
        isExpanded 
          ? "inset-4" 
          : "bottom-4 right-4 w-[500px] h-[350px]"
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-[#12121a]">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-gold" />
          <span className="text-sm font-medium">Debug Console</span>
          {errorCount > 0 && (
            <Badge variant="destructive" className="h-5 px-1.5 text-xs">
              {errorCount} errors
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          {(errorCount > 0 || warnCount > 0) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={copyAllErrors}
              className="h-7 px-2 text-xs gap-1 text-red-400 hover:text-red-300 hover:bg-red-500/10"
              title="Copy all errors to clipboard (formatted for pasting)"
            >
              {copied ? (
                <CheckCheck className="w-3 h-3 text-emerald-400" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
              Copy Errors
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={copyLogs}
            className="h-7 w-7 p-0"
            title="Copy all logs"
          >
            {copied ? (
              <CheckCheck className="w-4 h-4 text-emerald-400" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => debugLogger.clear()}
            className="h-7 w-7 p-0"
            title="Clear logs"
          >
            <Trash2 className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsExpanded(!isExpanded)}
            className="h-7 w-7 p-0"
            title={isExpanded ? "Collapse" : "Expand"}
          >
            {isExpanded ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronUp className="w-4 h-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsOpen(false)}
            className="h-7 w-7 p-0"
            title="Close"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Logs */}
      <ScrollArea className={cn("flex-1", isExpanded ? "h-[calc(100%-44px)]" : "h-[306px]")}>
        <div className="p-2 space-y-1 font-mono text-xs" ref={scrollRef}>
          {logs.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">
              No logs yet. Interact with the app to see debug output.
            </div>
          ) : (
            logs.map((log) => (
              <LogLine key={log.id} log={log} />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function LogLine({ log }: { log: LogEntry }) {
  const [expanded, setExpanded] = useState(false);

  const levelColors = {
    info: 'text-blue-400',
    warn: 'text-amber-400',
    error: 'text-red-400',
    debug: 'text-gray-400',
  };

  const time = log.timestamp.toLocaleTimeString('en-US', { 
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  return (
    <div 
      className={cn(
        "rounded px-2 py-1.5 cursor-pointer hover:bg-white/5 transition-colors",
        log.level === 'error' && "bg-red-500/5 border-l-2 border-red-500",
        log.level === 'warn' && "bg-amber-500/5 border-l-2 border-amber-500"
      )}
      onClick={() => log.data && setExpanded(!expanded)}
    >
      <div className="flex items-start gap-2">
        <span className="text-muted-foreground shrink-0">{time}</span>
        <span className={cn("shrink-0 uppercase w-12", levelColors[log.level])}>
          {log.level}
        </span>
        {log.source && (
          <Badge variant="outline" className="h-4 px-1 text-[10px] shrink-0">
            {log.source}
          </Badge>
        )}
        <span className="text-foreground flex-1 break-all">{String(log.message)}</span>
        {!!log.data && (
          <ChevronDown className={cn(
            "w-3 h-3 text-muted-foreground shrink-0 transition-transform",
            expanded && "rotate-180"
          )} />
        )}
      </div>
      {expanded && !!log.data && (
        <pre className="mt-2 p-2 bg-black/30 rounded text-[10px] overflow-x-auto text-muted-foreground">
          {JSON.stringify(log.data as object, null, 2)}
        </pre>
      )}
    </div>
  );
}

