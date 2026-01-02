import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    hasApiKey: !!process.env.CASE_API_KEY,
    apiKeyPrefix: process.env.CASE_API_KEY?.substring(0, 10) || 'NOT SET',
    hasCasemarkKey: !!process.env.CASEMARK_API_KEY,
    casemarkKeyPrefix: process.env.CASEMARK_API_KEY?.substring(0, 10) || 'NOT SET',
    nodeEnv: process.env.NODE_ENV,
    allEnvKeys: Object.keys(process.env).filter(k => k.includes('CASE') || k.includes('API')),
  });
}
