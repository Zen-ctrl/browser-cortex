import { useEffect, useState } from 'react';
import { Badge, Button, Field, Icon, Notice, Panel, Switch } from '@browser-cortex/ui';

interface Settings {
  onlinePolicy: 'deny' | 'ask';
  autoLockMinutes: number;
  detailedReceipts: boolean;
  retainActivityDays: number;
}

const defaults: Settings = { onlinePolicy: 'deny', autoLockMinutes: 15, detailedReceipts: false, retainActivityDays: 30 };

function readSettings(value: Record<string, unknown>): Settings {
  return {
    onlinePolicy: value.onlinePolicy === 'ask' ? 'ask' : 'deny',
    autoLockMinutes: [5,15,30,60].includes(Number(value.autoLockMinutes)) ? Number(value.autoLockMinutes) : defaults.autoLockMinutes,
    detailedReceipts: value.detailedReceipts === true,
    retainActivityDays: [0,7,30].includes(Number(value.retainActivityDays)) ? Number(value.retainActivityDays) : defaults.retainActivityDays,
  };
}

export function OptionsApp() {
  const [settings, setSettings] = useState<Settings>(defaults);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { void chrome.storage.local.get(Object.keys(defaults)).then((value) => { setSettings(readSettings(value)); setLoaded(true); }).catch(() => { setError('Could not read extension settings.'); setLoaded(true); }); }, []);
  async function save() { setError(''); setSaved(false); try { await chrome.storage.local.set(settings); setSaved(true); window.setTimeout(() => setSaved(false), 2400); } catch { setError('Could not save extension settings.'); } }
  return <div className="options-shell"><header><div className="options-brand"><span><i /><i /><i /></span><div><strong>BrowserCortex</strong><small>Extension settings</small></div></div><Badge dot tone="positive">Local only by default</Badge></header><main>{error && <Notice title="Settings unavailable" tone="danger">{error}</Notice>}<section className="options-hero"><p>Permission center</p><h1>Narrow defaults, clear decisions.</h1><span>These settings apply to the extension origin. A website cannot change them through page content or a tool description.</span></section><div className="options-grid"><Panel eyebrow="Routing" title="Online assistance"><div className="option-body"><label className={`route-option${settings.onlinePolicy === 'deny' ? ' is-selected' : ''}`}><input checked={settings.onlinePolicy === 'deny'} name="online" onChange={() => setSettings((current) => ({ ...current, onlinePolicy: 'deny' }))} type="radio" /><span><Icon name="lock" /></span><div><strong>Local only</strong><small>Never send an inference request online.</small></div></label><label className={`route-option${settings.onlinePolicy === 'ask' ? ' is-selected' : ''}`}><input checked={settings.onlinePolicy === 'ask'} name="online" onChange={() => setSettings((current) => ({ ...current, onlinePolicy: 'ask' }))} type="radio" /><span><Icon name="eye" /></span><div><strong>Ask before online</strong><small>Allow exact disclosure and a one-use approval flow.</small></div></label><Notice title="No silent fallback" tone="positive">A local error never changes this setting or activates an endpoint.</Notice></div></Panel><Panel eyebrow="Vault" title="Lock and retention"><div className="option-body"><Field label="Auto-lock after inactivity"><select onChange={(event) => setSettings((current) => ({ ...current, autoLockMinutes: Number(event.target.value) }))} value={settings.autoLockMinutes}><option value={5}>5 minutes</option><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>1 hour</option></select></Field><Field label="Keep scrubbed activity summaries"><select onChange={(event) => setSettings((current) => ({ ...current, retainActivityDays: Number(event.target.value) }))} value={settings.retainActivityDays}><option value={0}>Do not retain</option><option value={7}>7 days</option><option value={30}>30 days</option></select></Field><Switch checked={settings.detailedReceipts} description="When enabled, details are encrypted and retained separately from scrubbed activity." label="Encrypted detailed receipts" onChange={(event) => setSettings((current) => ({ ...current, detailedReceipts: event.target.checked }))} /></div></Panel></div><Panel className="scope-panel" eyebrow="Site scope" title="Access is granted from the active tab"><div className="scope-body"><span><Icon name="privacy" size={22} /></span><div><strong>No broad host permission is installed</strong><p>The panel uses <code>activeTab</code> and injects packaged capture code only after a user action. Recording is restricted in code to the bundled local demo origins.</p></div></div></Panel><div className="save-row"><span>{saved ? 'Settings saved on this device.' : loaded ? 'Ready to save.' : 'Loading settings...'}</span><Button disabled={!loaded} icon="check" onClick={() => void save()} tone="primary">Save settings</Button></div></main></div>;
}
