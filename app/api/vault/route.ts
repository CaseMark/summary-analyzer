import { NextRequest, NextResponse } from 'next/server';

const API_BASE_URL = process.env.CASE_API_URL || 'https://api.case.dev';
const API_KEY = process.env.CASE_API_KEY || '';

// Helper to log with timestamp and color
function log(level: 'info' | 'error' | 'warn', message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [API/vault]`;
  
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
    log('info', 'Creating vault...', body);

    if (!API_KEY) {
      log('error', 'CASE_API_KEY is not set');
      return NextResponse.json(
        { error: 'Server configuration error: API key not set' },
        { status: 500 }
      );
    }

    const targetUrl = `${API_BASE_URL}/vault`;
    log('info', `Proxying to: ${targetUrl}`);

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    log('info', `Case.dev responded: ${response.status}`, data);

    if (!response.ok) {
      log('error', 'Vault creation failed', { status: response.status, data });
      return NextResponse.json(
        { error: data.message || data.error || 'Failed to create vault' },
        { status: response.status }
      );
    }

    log('info', 'Vault created successfully', { id: data.id });
    return NextResponse.json(data);
  } catch (error) {
    log('error', 'Vault creation exception', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    log('info', 'Listing vaults...');

    if (!API_KEY) {
      log('error', 'CASE_API_KEY is not set');
      return NextResponse.json(
        { error: 'Server configuration error: API key not set' },
        { status: 500 }
      );
    }

    const targetUrl = `${API_BASE_URL}/vault`;
    log('info', `Proxying to: ${targetUrl}`);

    const response = await fetch(targetUrl, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
      },
    });

    const data = await response.json();
    log('info', `Case.dev responded: ${response.status}`, { vaultCount: data?.vaults?.length });

    if (!response.ok) {
      log('error', 'Vault list failed', { status: response.status, data });
      return NextResponse.json(
        { error: data.message || data.error || 'Failed to list vaults' },
        { status: response.status }
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    log('error', 'Vault list exception', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}

