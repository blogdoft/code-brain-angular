/** Environment variable that suppresses the splash screen (`1` or `true`). */
export const NO_LOGO_ENVIRONMENT_VARIABLE = 'CIIR_NOLOGO';

export const BLOG_URL = 'https://www.blogdoft.com.br/';

const TOOL_NAME_ART = [
  '  ____  ___  ___  ____',
  ' / ___||_ _||_ _||  _ \\',
  '| |     | |  | | | |_) |',
  '| |___  | |  | | |  _ <',
  ' \\____||___||___||_| \\_\\',
];

const BLOG_DO_FT_ART = [
  ' ____   _                 ____          _____  _____',
  '| __ ) | |  ___    __ _  |  _ \\   ___  |  ___||_   _|',
  '|  _ \\ | | / _ \\  / _` | | | | | / _ \\ | |_     | |',
  '| |_) || || (_) || (_| | | |_| || (_) ||  _|    | |',
  '|____/ |_| \\___/  \\__, | |____/  \\___/ |_|      |_|',
  '                  |___/',
];

const NOTICES = [
  'Requires Node.js 20 or later.',
  "Install the analyzed project's dependencies first (npm install / npm ci); code-brain-angular will not.",
  'Without node_modules, imports of packages resolve as unresolved relations.',
];

export function isSplashSuppressed(noBannerOption: boolean, noLogoValue: string | undefined): boolean {
  const value = noLogoValue?.trim().toLowerCase();
  return noBannerOption || value === '1' || value === 'true';
}

/**
 * Banner, blog link, then prerequisite notices, in that order, followed by a blank line. ASCII
 * only, no ANSI escapes, so it renders the same on any console and in CI logs.
 */
export function renderSplash(version: string): string {
  return [
    ...TOOL_NAME_ART,
    `code-brain-angular ${version} - TypeScript/Angular CIIR generator`,
    '',
    ...BLOG_DO_FT_ART,
    BLOG_URL,
    '',
    ...NOTICES.map((notice) => `* ${notice}`),
    '',
    '',
  ].join('\n');
}
