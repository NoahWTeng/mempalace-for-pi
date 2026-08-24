import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
// @ts-expect-error Pi exposes this package to extensions; it is nested under the pinned host here.
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';

const expectedTools = ['palace_diary', 'palace_save', 'palace_search', 'palace_status'];
const finding = 'packaged-pi-fresh-record';
const diary = 'packaged Pi diary entry';

export default function packagedProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    models: [{ id: 'scripted', name: 'Packaged MemPalace acceptance', input: ['text'] }],
    provider: 'mempalace-packaged-local',
  });
  let step = 0;
  const disabled = process.env.MEMPALACE_PROVIDER_EXPECT_DISABLED === '1';
  const incompatible = process.env.MEMPALACE_PROVIDER_EXPECT_INCOMPATIBLE === '1';
  const verifyOnly = process.env.MEMPALACE_PROVIDER_VERIFY_ONLY === '1';
  const calls = disabled || incompatible ? [] : verifyOnly ? [
    ['palace_search', { query: 'packaged pi fresh record', wing: 'acceptance', limit: 5 }],
    ['palace_diary', { action: 'read', agent_name: 'pi', wing: 'acceptance', last_n: 20 }],
    ['palace_status', {}],
  ] as const : [
    ['palace_save', { content: finding, wing: 'acceptance', room: 'journey', source_file: 'packaged-acceptance' }],
    ['palace_diary', { action: 'write', agent_name: 'pi', content: diary, topic: 'acceptance', wing: 'acceptance' }],
    ['palace_search', { query: 'packaged pi fresh record', wing: 'acceptance', limit: 5 }],
    ['palace_diary', { action: 'read', agent_name: 'pi', wing: 'acceptance', last_n: 20 }],
    ['palace_status', {}],
    ['palace_save', { content: finding, wing: 'acceptance', room: 'journey', source_file: 'packaged-acceptance' }],
  ] as const;
  faux.setResponses(Array.from({ length: 12 }, () => (context: {
    tools?: Array<{ name: string }>;
    messages?: Array<{ role?: string; isError?: boolean; content?: unknown }>;
  }) => {
    const names = (context.tools ?? []).map(({ name }) => name).sort();
    const last = context.messages?.at(-1);
    if (last?.role === 'toolResult') {
      const result = JSON.stringify(last.content);
      if (last.isError || /"success":false|"error"/u.test(result)) {
        throw new Error(`packaged tool failed: ${result}`);
      }
      const completed = calls[step - 1]?.[0];
      if (completed === 'palace_search' && !result.includes(finding)) throw new Error(`search lost exact finding: ${result}`);
      if (completed === 'palace_diary' && ((verifyOnly && step === 2) || (!verifyOnly && step === 4)) && !result.includes(diary)) {
        throw new Error(`diary read lost exact entry: ${result}`);
      }
      if (completed === 'palace_status' && !/total_drawers|wings/u.test(result)) throw new Error(`status lacks palace semantics: ${result}`);
      if (completed === 'palace_save' && step === calls.length && !/duplicate found/u.test(result)) {
        throw new Error(`duplicate result lacks existing-record evidence: ${result}`);
      }
    }
    const wanted = disabled ? [] : expectedTools;
    if (names.join(',') !== wanted.join(',')) {
      throw new Error(`packaged Pi loaded unexpected tools: ${names.join(',')}`);
    }
    const next = calls[step++];
    if (next) return fauxAssistantMessage(fauxToolCall(next[0], next[1], { id: `packaged-${step}` }), { stopReason: 'toolUse' });
    return fauxAssistantMessage(`PACKAGED_PROVIDER_PASS ${JSON.stringify({ tools: names, disabled, incompatible, verifyOnly })}`, { stopReason: 'stop' });
  }));
  pi.registerProvider(faux.provider);
}
