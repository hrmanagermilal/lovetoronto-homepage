import mentalHealthOverrides from './contact-overrides.json';

interface FieldDefinition {
  name: string;
  type: 'text' | 'email' | 'tel' | 'textarea' | 'select' | 'checkbox' | 'date';
  required: boolean;
  max_length: number;
  format?: 'date' | 'year' | null;
}
interface RepresentativeRule {
  type: 'representative';
  trigger_fields: string[];
  name_fields: string[];
  required_fields: string[];
  consent_field: string;
  consent_value: string;
}
interface Category {
  slug: string;
  name: string;
  language: string;
  form_id: string;
  fields: FieldDefinition[];
  rules: RepresentativeRule[];
}
interface Receipt { id: string; status: 'pending' | 'sent' | 'failed' }

function parseCategories(value: unknown): Category[] {
  if (!Array.isArray(value)) throw new Error('Invalid category response');
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' ||
        !('slug' in item) || typeof item.slug !== 'string' ||
        !('name' in item) || typeof item.name !== 'string' ||
        !('language' in item) || typeof item.language !== 'string' ||
        !('form_id' in item) || typeof item.form_id !== 'string' ||
        !('fields' in item) || !Array.isArray(item.fields)) throw new Error('Invalid category');
    const fields = item.fields.map((field: unknown): FieldDefinition => {
      if (!field || typeof field !== 'object' ||
          !('name' in field) || typeof field.name !== 'string' ||
          !('type' in field) || !['text', 'email', 'tel', 'textarea', 'select', 'checkbox', 'date'].includes(String(field.type)) ||
          !('required' in field) || typeof field.required !== 'boolean' ||
          !('max_length' in field) || typeof field.max_length !== 'number') throw new Error('Invalid field definition');
      const format = 'format' in field ? field.format : null;
      if (format !== null && format !== 'date' && format !== 'year') throw new Error('Invalid field format');
      return { name: field.name, type: field.type as FieldDefinition['type'],
        required: field.required, max_length: field.max_length, format };
    });
    const rawRules: unknown = 'rules' in item ? item.rules : [];
    if (!Array.isArray(rawRules)) throw new Error('Invalid category rules');
    const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
    const rules = rawRules.map((rule: unknown): RepresentativeRule => {
      if (!rule || typeof rule !== 'object' ||
          !('type' in rule) || rule.type !== 'representative' ||
          !('trigger_fields' in rule) || !strings(rule.trigger_fields) ||
          !('name_fields' in rule) || !strings(rule.name_fields) ||
          !('required_fields' in rule) || !strings(rule.required_fields) ||
          !('consent_field' in rule) || typeof rule.consent_field !== 'string' ||
          !('consent_value' in rule) || typeof rule.consent_value !== 'string') throw new Error('Invalid representative rule');
      return { type: rule.type, trigger_fields: rule.trigger_fields, name_fields: rule.name_fields,
        required_fields: rule.required_fields, consent_field: rule.consent_field, consent_value: rule.consent_value };
    });
    return { slug: item.slug, name: item.name, language: item.language, form_id: item.form_id, fields, rules };
  });
}

function parseReceipt(value: unknown): Receipt {
  if (!value || typeof value !== 'object' ||
      !('id' in value) || typeof value.id !== 'string' ||
      !('status' in value) || !['pending', 'sent', 'failed'].includes(String(value.status))) {
    throw new Error('Invalid inquiry response');
  }
  return { id: value.id, status: value.status as Receipt['status'] };
}

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
function requestKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const controls = (form: HTMLFormElement) => [...form.querySelectorAll<Control>('input[name], textarea[name], select[name]')]
  .filter(control => !control.name.startsWith('_') && control.type !== 'submit');

export function createContactController(root: HTMLElement, language: string | undefined, pageId: string) {
  const selector = root.querySelector<HTMLSelectElement>('#menu-service');
  if (!selector) return { dispose() {} };
  const en = language === 'en';
  const abort = new AbortController();
  const cleanups: (() => void)[] = [];
  const categories = new Map<string, Category>();
  const boxes = [...root.querySelectorAll<HTMLElement>('.grop-contact_form')];
  const statuses = new Map<HTMLFormElement, HTMLElement>();
  const pending = new Set<HTMLFormElement>();
  const requests = new Map<HTMLFormElement, { key: string; body: string }>();
  const complete = new Set<HTMLFormElement>();
  const notice = document.createElement('p');
  notice.dataset.inquiryRuntime = 'true';
  notice.setAttribute('role', 'status');
  notice.textContent = en ? 'Loading inquiry categories…' : '문의 분류를 불러오는 중입니다…';
  selector.parentElement?.append(notice);
  const status = (form: HTMLFormElement, text: string) => {
    const element = statuses.get(form);
    if (element) element.textContent = text;
  };
  function showCategory() {
    for (const box of boxes) {
      const selected = !!selector!.value && box.classList.contains(selector!.value);
      box.style.display = selected ? 'block' : 'none';
      box.hidden = !selected;
    }
  }
  selector.addEventListener('change', showCategory);
  const initial = pageId.match(/menu=(contact-\d+)/)?.[1];
  if (initial) selector.value = initial;
  showCategory();

  for (const box of boxes) {
    const form = box.querySelector<HTMLFormElement>('form.wpcf7-form');
    if (!form) continue;
    const formId = form.querySelector<HTMLInputElement>('input[name="_wpcf7"]')?.value;
    if (!formId) continue;
    if (formId === mentalHealthOverrides.form_id) {
      for (const [name, label] of Object.entries(mentalHealthOverrides.labels)) {
        const control = controls(form).find(control => control.name === name);
        if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
          control.placeholder = label;
          control.setAttribute('aria-label', label);
        }
      }
      let after = controls(form).find(control => control.name === mentalHealthOverrides.after)
        ?.closest('.grop-confrm_sigl');
      for (const field of mentalHealthOverrides.fields) {
        if (controls(form).some(control => control.name === field.name)) continue;
        const wrapper = document.createElement('div');
        wrapper.className = 'grop-input-col-1 grop-confrm_sigl';
        const paragraph = document.createElement('p');
        const input = document.createElement('input');
        input.className = 'wpcf7-form-control wpcf7-text grop-form-control';
        input.type = field.type;
        input.name = field.name;
        input.placeholder = field.label;
        input.setAttribute('aria-label', field.label);
        input.required = field.required;
        input.maxLength = field.max_length;
        paragraph.append(input);
        wrapper.append(paragraph);
        after?.after(wrapper);
        after = wrapper;
      }
    }
    const output = document.createElement('p');
    output.dataset.inquiryRuntime = 'true';
    output.setAttribute('role', 'status');
    output.setAttribute('aria-live', 'polite');
    form.append(output);
    statuses.set(form, output);
    const buttons = [...form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('button, input[type="submit"]')];
    const consent = form.querySelector<HTMLElement>('.waiver-info');
    const waiverButton = form.querySelector<HTMLButtonElement>('.waiver-popup');
    let waiverRead = false;
    const dialogId = waiverButton?.dataset.ref;
    const sourceDialog = dialogId ? root.querySelector<HTMLElement>(`#dialog-${CSS.escape(dialogId)}`) : null;
    let dialog: HTMLDialogElement | undefined;
    if (sourceDialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'inquiry-waiver-dialog';
      dialog.setAttribute('aria-label', en ? 'Waiver of liability' : '면책 동의서');
      dialog.append(sourceDialog.cloneNode(true));
      const copy = dialog.firstElementChild;
      if (copy instanceof HTMLElement) {
        copy.removeAttribute('id');
        copy.style.display = 'block';
      }
      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = en ? 'I have read this waiver' : '동의서를 확인했습니다';
      close.addEventListener('click', () => {
        waiverRead = true;
        dialog!.close();
        if (consent) consent.style.display = 'block';
      });
      dialog.append(close);
      document.body.append(dialog);
      cleanups.push(() => dialog?.remove());
      const open = () => dialog!.showModal();
      waiverButton?.addEventListener('click', open);
      cleanups.push(() => waiverButton?.removeEventListener('click', open));
    }
    function update() {
      const category = categories.get(formId!);
      for (const button of buttons) {
        button.disabled = !category || pending.has(form!) || complete.has(form!) ||
          (button === waiverButton && !dialog);
      }
    }
    update();
    status(form, en ? 'This category is not yet available for submission.' : '현재 이 분류는 온라인 접수 준비 중입니다.');

    async function send(event: SubmitEvent) {
      event.preventDefault();
      event.stopPropagation();
      const category = categories.get(formId!);
      if (!category || pending.has(form!) || complete.has(form!)) return;
      if (waiverButton && !waiverRead) {
        dialog?.showModal();
        return;
      }
      const fields: Record<string, string | boolean> = {};
      for (const control of controls(form!)) control.setCustomValidity('');
      for (const definition of category.fields) {
        const control = controls(form!).find(control => control.name === definition.name);
        if (!control) {
          status(form!, en ? 'The form configuration has changed. Please contact the office.' : '양식 설정이 변경되었습니다. 사무실로 문의해 주세요.');
          return;
        }
        control.required = definition.required;
        if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
          control.maxLength = definition.max_length;
        }
        if (control instanceof HTMLInputElement) {
          if (definition.format === 'date') control.pattern = '[0-9]{4}-[0-9]{2}-[0-9]{2}';
          else if (definition.format === 'year') control.pattern = '[0-9]{4}';
        }
        fields[definition.name] = control instanceof HTMLInputElement && control.type === 'checkbox'
          ? control.checked : control.value;
      }
      const filled = (name: string) => typeof fields[name] === 'string' ? fields[name].trim() !== '' : fields[name] === true;
      const invalid = (name: string, message: string) => controls(form!).find(control => control.name === name)?.setCustomValidity(message);
      for (const rule of category.rules) {
        if (!rule.trigger_fields.some(filled)) continue;
        if (!rule.name_fields.some(filled)) {
          invalid(rule.name_fields[0], en ? 'Enter a representative name in English or Korean.' : '대리인 영문 또는 한글 이름을 입력해 주세요.');
        }
        for (const name of rule.required_fields) {
          if (!filled(name)) invalid(name, en ? 'Required for a representative application.' : '대리 신청 시 반드시 입력해 주세요.');
        }
        if (fields[rule.consent_field] !== rule.consent_value) {
          invalid(rule.consent_field, en ? 'Authorization to apply on behalf of the client is required.' : '대리 신청 권한에 동의해 주세요.');
        }
      }
      if (!form!.reportValidity()) return;
      const body = JSON.stringify({ category: category.slug, fields });
      const previous = requests.get(form!);
      const request = previous?.body === body ? previous : { key: requestKey(), body };
      requests.set(form!, request);
      pending.add(form!);
      update();
      status(form!, en ? 'Submitting…' : '접수 중입니다…');
      try {
        const response = await fetch('/api/v1/inquiries', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.key },
          body, signal: abort.signal,
        });
        if (!response.ok) {
          const error = await response.json();
          console.error('Inquiry rejected', response.status);
          if (response.status === 422 && error?.detail?.fields) {
            for (const [name, message] of Object.entries(error.detail.fields)) {
              const control = controls(form!).find(control => control.name === name);
              control?.setCustomValidity(String(message));
            }
            form!.reportValidity();
          }
          throw new Error(en ? `Submission failed (HTTP ${response.status}). Please check the form and retry.`
            : `접수에 실패했습니다 (HTTP ${response.status}). 입력 내용을 확인한 뒤 다시 시도해 주세요.`);
        }
        const result = parseReceipt(await response.json());
        if (result.status === 'failed') {
          status(form!, en ? `Saved, but email delivery failed. Please contact the office. Reference: ${result.id}`
            : `문의는 저장되었으나 메일 발송에 실패했습니다. 사무실로 문의해 주세요. 접수번호: ${result.id}`);
        } else {
          status(form!, en ? `Your inquiry was saved${result.status === 'pending' ? ' and queued for email delivery' : ''}. Reference: ${result.id}`
            : `문의가 저장되었습니다${result.status === 'pending' ? ' (메일 발송 대기)' : ''}. 접수번호: ${result.id}`);
        }
        complete.add(form!);
        for (const control of controls(form!)) control.disabled = true;
      } catch (error) {
        if (abort.signal.aborted) return;
        console.error('Inquiry submission failed', error);
        status(form!, error instanceof Error ? error.message : (en ? 'Submission failed. Please retry.' : '접수에 실패했습니다. 다시 시도해 주세요.'));
      } finally {
        pending.delete(form!);
        update();
      }
    }
    const input = (event: Event) => {
      const control = event.target;
      if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) {
        for (const field of controls(form!)) field.setCustomValidity('');
      }
    };
    form.addEventListener('submit', send);
    form.addEventListener('input', input);
    cleanups.push(() => { form.removeEventListener('submit', send); form.removeEventListener('input', input); output.remove(); });
    cleanups.push(() => buttons.forEach(button => { button.disabled = true; }));
    form.dataset.inquiryForm = 'true';
    const refresh = () => update();
    form.addEventListener('inquiry-ready', refresh);
    cleanups.push(() => { form.removeEventListener('inquiry-ready', refresh); delete form.dataset.inquiryForm; });
  }
  void (async () => {
    try {
      const response = await fetch('/api/v1/inquiry-categories', { signal: abort.signal });
      if (!response.ok) throw new Error(`Categories returned HTTP ${response.status}`);
      for (const category of parseCategories(await response.json())) {
        if (category.language === language) categories.set(category.form_id, category);
      }
      notice.textContent = categories.size ? '' : (en ? 'Online inquiries are being configured. Please contact the office.'
        : '온라인 문의 접수를 준비 중입니다. 사무실로 문의해 주세요.');
      for (const form of statuses.keys()) {
        const id = form.querySelector<HTMLInputElement>('input[name="_wpcf7"]')?.value;
        if (id && categories.has(id)) status(form, '');
        form.dispatchEvent(new Event('inquiry-ready'));
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      console.error('Inquiry category load failed', error);
      notice.textContent = en ? 'Could not load inquiry settings. Reload this page or contact the office.'
        : '문의 설정을 불러오지 못했습니다. 페이지를 새로고침하거나 사무실로 문의해 주세요.';
    }
  })();
  return {
    dispose() {
      abort.abort();
      selector.removeEventListener('change', showCategory);
      notice.remove();
      for (const cleanup of cleanups) cleanup();
    },
  };
}
