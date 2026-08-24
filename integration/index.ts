import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { createExtension } from './extension.ts';

export default function registerMemPalace(pi: ExtensionAPI): void {
  createExtension(pi);
}
