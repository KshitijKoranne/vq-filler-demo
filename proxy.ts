import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getTrialStatus } from './lib/trial';

export function proxy(request: NextRequest) {
  const status = getTrialStatus();
  const { pathname } = request.nextUrl;

  if (pathname === '/trial-expired') {
    if (!status.active) return NextResponse.next();
    return NextResponse.redirect(new URL('/', request.url));
  }

  if (status.active) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({
      error: status.reason || 'This trial is not active.',
      trial: status,
    }, { status: 403 });
  }

  return NextResponse.redirect(new URL('/trial-expired', request.url));
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
