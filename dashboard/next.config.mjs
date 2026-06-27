import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin tracing to this app — avoids Next picking up a stray lockfile in $HOME.
  outputFileTracingRoot: here,
};

export default nextConfig;
