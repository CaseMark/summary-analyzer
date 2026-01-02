import { NextRequest, NextResponse } from 'next/server';

const API_BASE_URL = process.env.CASE_API_URL || 'https://api.case.dev';
const API_KEY = process.env.CASE_API_KEY || '';

// Helper to log with timestamp and color
function log(level: 'info' | 'error' | 'warn', message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [API/llm]`;
  
  if (level === 'error') {
    console.error(`${prefix} ❌ ${message}`, data ?? '');
  } else if (level === 'warn') {
    console.warn(`${prefix} ⚠️ ${message}`, data ?? '');
  } else {
    console.log(`${prefix} ✓ ${message}`, data ?? '');
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const model = body.model || 'unknown';
    const messageCount = body.messages?.length || 0;
    
    // Calculate request size for debugging
    const bodyString = JSON.stringify(body);
    const bodySizeKB = (bodyString.length / 1024).toFixed(1);
    const bodySizeMB = (bodyString.length / (1024 * 1024)).toFixed(2);
    
    // Check if this is a multimodal request (PDF/image)
    const hasMultimodal = body.messages?.some((m: { content: unknown }) => 
      Array.isArray(m.content) && m.content.some((c: { type?: string }) => c.type === 'image_url')
    );
    
    log('info', `Chat completion request`, { 
      model, 
      messageCount,
      maxTokens: body.max_tokens,
      temperature: body.temperature,
      requestSizeKB: bodySizeKB,
      requestSizeMB: hasMultimodal ? bodySizeMB : undefined,
      isMultimodal: hasMultimodal,
    });

    // Warn about large requests that might timeout
    const sizeInMB = bodyString.length / (1024 * 1024);
    if (sizeInMB > 5) {
      log('warn', `Large request detected (${bodySizeMB} MB) - may take several minutes or timeout`, { model });
    }

    if (!API_KEY) {
      log('error', 'CASE_API_KEY is not set');
      return NextResponse.json(
        { error: 'Server configuration error: API key not set' },
        { status: 500 }
      );
    }

    const targetUrl = `${API_BASE_URL}/llm/v1/chat/completions`;
    log('info', `Proxying to: ${targetUrl}`);

    const startTime = Date.now();
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const duration = Date.now() - startTime;
    
    // Try to parse response as JSON, but handle non-JSON error responses
    let data;
    const responseText = await response.text();
    try {
      data = JSON.parse(responseText);
    } catch {
      // Response is not valid JSON - treat as error message
      log('error', `Non-JSON response from API (${response.status}) in ${duration}ms`, {
        model,
        status: response.status,
        responseText: responseText.substring(0, 200),
      });
      return NextResponse.json(
        { error: responseText || `API returned non-JSON response (${response.status})` },
        { status: response.status || 500 }
      );
    }

    if (!response.ok) {
      log('error', `LLM completion failed (${response.status}) in ${duration}ms`, { 
        model,
        status: response.status, 
        error: data.message || data.error,
        data 
      });
      return NextResponse.json(
        { error: data.message || data.error || 'Failed to create completion' },
        { status: response.status }
      );
    }

    const usage = data.usage || {};
    log('info', `LLM completion succeeded in ${duration}ms`, { 
      model,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      finishReason: data.choices?.[0]?.finish_reason
    });

    return NextResponse.json(data);
  } catch (error) {
    log('error', 'LLM completion exception', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}


