import { NextResponse, NextRequest } from 'next/server';

// Simple password protection via environment variable
const SITE_PASSWORD = process.env.SITE_PASSWORD;

export function middleware(request: NextRequest) {
  // If no password is set, allow all access
  if (!SITE_PASSWORD) {
    return NextResponse.next();
  }

  // Check for password cookie
  const passwordCookie = request.cookies.get('site_password');
  
  // Allow access to the password page itself
  if (request.nextUrl.pathname === '/password') {
    return NextResponse.next();
  }
  
  // Allow the password verification API
  if (request.nextUrl.pathname === '/api/verify-password') {
    return NextResponse.next();
  }

  // Check if password matches
  if (passwordCookie?.value === SITE_PASSWORD) {
    return NextResponse.next();
  }

  // Redirect to password page
  return NextResponse.redirect(new URL('/password', request.url));
}

export const config = {
  matcher: [
    // Skip Next.js internals and static files
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
  ],
};
