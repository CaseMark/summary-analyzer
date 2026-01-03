import { NextRequest, NextResponse } from 'next/server';

// Production CaseMark API for generating control summaries
const PROD_API_URL = process.env.CASE_PROD_API_URL || process.env.CASEMARK_PROD_API_URL || 'https://api.casemarkai.com';
const PROD_API_KEY = process.env.CASE_PROD_API_KEY || process.env.CASEMARK_PROD_API_KEY || '';

// Helper to log with timestamp
function log(level: 'info' | 'error' | 'warn', message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [API/llm/production]`;
  
  if (level === 'error') {
    console.error(`${prefix} ❌ ${message}`, data ?? '');
  } else if (level === 'warn') {
    console.warn(`${prefix} ⚠️ ${message}`, data ?? '');
  } else {
    console.log(`${prefix} ✓ ${message}`, data ?? '');
  }
}

// GET - Check if production API is configured
export async function GET() {
  const isConfigured = !!PROD_API_KEY;
  
  return NextResponse.json({
    configured: isConfigured,
    url: isConfigured ? PROD_API_URL : null,
  });
}

// POST - Generate control summary via production API
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const model = body.model || 'unknown';
    const messageCount = body.messages?.length || 0;
    
    log('info', `Production chat completion request`, { 
      model, 
      messageCount,
      maxTokens: body.max_tokens,
    });

    if (!PROD_API_KEY) {
      log('error', 'Production API key is not configured');
      return NextResponse.json(
        { 
          error: 'Production API not configured',
          hint: 'Set CASE_PROD_API_KEY or CASEMARK_PROD_API_KEY environment variable'
        },
        { status: 503 }
      );
    }

    const targetUrl = `${PROD_API_URL}/llm/v1/chat/completions`;
    log('info', `Proxying to production: ${targetUrl}`);

    const startTime = Date.now();
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PROD_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    const duration = Date.now() - startTime;

    if (!response.ok) {
      log('error', `Production LLM completion failed (${response.status}) in ${duration}ms`, { 
        model,
        status: response.status, 
        error: data.message || data.error,
      });
      return NextResponse.json(
        { error: data.message || data.error || 'Failed to create production completion' },
        { status: response.status }
      );
    }

    const usage = data.usage || {};
    log('info', `Production LLM completion succeeded in ${duration}ms`, { 
      model,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    });

    return NextResponse.json(data);
  } catch (error) {
    log('error', 'Production LLM completion exception', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}




