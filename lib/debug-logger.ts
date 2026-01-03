'use client';

// Debug logger that stores logs in memory and can be displayed in UI

export interface LogEntry {
  id: string;
  timestamp: Date;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  data?: unknown;
  source?: string;
}

const MAX_LOGS = 100;

class DebugLogger {
  private logs: LogEntry[] = [];
  private listeners: Set<(logs: LogEntry[]) => void> = new Set();

  private addLog(level: LogEntry['level'], message: string, data?: unknown, source?: string) {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: new Date(),
      level,
      message,
      data,
      source,
    };

    this.logs = [entry, ...this.logs].slice(0, MAX_LOGS);
    
    // Also log to console
    const consoleFn = level === 'error' ? console.error 
      : level === 'warn' ? console.warn 
      : level === 'debug' ? console.debug 
      : console.log;
    
    consoleFn(`[${source || 'app'}] ${message}`, data !== undefined ? data : '');
    
    // Notify listeners
    this.listeners.forEach(listener => listener(this.logs));
  }

  info(message: string, data?: unknown, source?: string) {
    this.addLog('info', message, data, source);
  }

  warn(message: string, data?: unknown, source?: string) {
    this.addLog('warn', message, data, source);
  }

  error(message: string, data?: unknown, source?: string) {
    this.addLog('error', message, data, source);
  }

  debug(message: string, data?: unknown, source?: string) {
    this.addLog('debug', message, data, source);
  }

  getLogs(): LogEntry[] {
    return this.logs;
  }

  clear() {
    this.logs = [];
    this.listeners.forEach(listener => listener(this.logs));
  }

  subscribe(listener: (logs: LogEntry[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const debugLogger = new DebugLogger();

// Wrapper for fetch that logs requests and responses
export async function debugFetch(
  url: string,
  options?: RequestInit,
  source?: string
): Promise<Response> {
  const method = options?.method || 'GET';
  const logSource = source || 'fetch';
  
  debugLogger.info(`${method} ${url}`, { 
    headers: options?.headers,
    body: options?.body ? 'present' : undefined 
  }, logSource);

  try {
    const startTime = Date.now();
    const response = await fetch(url, options);
    const duration = Date.now() - startTime;
    
    // Clone response to read body for logging
    const clonedResponse = response.clone();
    
    try {
      const responseData = await clonedResponse.json();
      
      if (!response.ok) {
        debugLogger.error(`${method} ${url} failed (${response.status}) in ${duration}ms`, {
          status: response.status,
          statusText: response.statusText,
          body: responseData,
        }, logSource);
      } else {
        debugLogger.info(`${method} ${url} succeeded (${response.status}) in ${duration}ms`, {
          status: response.status,
          body: responseData,
        }, logSource);
      }
    } catch {
      // Response wasn't JSON
      if (!response.ok) {
        debugLogger.error(`${method} ${url} failed (${response.status}) in ${duration}ms`, {
          status: response.status,
          statusText: response.statusText,
        }, logSource);
      } else {
        debugLogger.info(`${method} ${url} succeeded (${response.status}) in ${duration}ms`, {
          status: response.status,
        }, logSource);
      }
    }
    
    return response;
  } catch (error) {
    debugLogger.error(`${method} ${url} network error`, {
      error: error instanceof Error ? error.message : String(error),
    }, logSource);
    throw error;
  }
}




