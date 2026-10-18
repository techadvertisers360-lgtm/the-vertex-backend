import { describe, expect, it } from 'vitest';
import { renderMessage, TEMPLATES, templateLabel, templateVariables } from '../../src/services/messageTemplates';

describe('§20 — WhatsApp template catalog', () => {
  it('every template renders text from its own variables and declares them', () => {
    for (const [key, t] of Object.entries(TEMPLATES)) {
      const payload = Object.fromEntries(t.variables.map((v) => [v === 'amount' ? 'amountPaisa' : v, v === 'amount' ? 150_000 : `<${v}>`]));
      const text = t.sensitive ? t.render(payload) : renderMessage(key, payload);
      expect(text, key).toBeTruthy();
      expect(templateVariables(key, payload)).toHaveLength(t.variables.length);
    }
  });

  it('procedure reminder names the session; variables keep their declared order', () => {
    const p = { patientName: 'Ayesha', procedure: 'Laser', session: 3, when: '20 Oct 2026, 3:00 PM', doctorName: 'Dr Sara', room: 'P02', location: 'The Vertex Health' };
    expect(renderMessage('procedure_reminder', p)).toBe('Yaad-dihani: Ayesha — Laser (session 3) 20 Oct 2026, 3:00 PM ko, Dr Sara, Room P02. The Vertex Health');
    expect(templateVariables('procedure_reminder', p)).toEqual(['Ayesha', 'Laser', '3', '20 Oct 2026, 3:00 PM', 'Dr Sara', 'P02', 'The Vertex Health']);
    expect(templateVariables('installment_reminder', { amountPaisa: 250_000 })[4]).toBe('Rs 2,500');
  });

  it('password-reset text is never rendered for the log; unknown templates fall back to the key', () => {
    expect(renderMessage('password_reset', { name: 'X', link: 'http://reset?token=abc' })).toBeNull();
    expect(templateLabel('custom_x')).toBe('custom_x');
    expect(renderMessage('custom_x', {})).toBeNull();
  });
});
