'use client';

import type { FormEvent } from 'react';

const INQUIRY_EMAIL = 'hello@founderai.system';

export function FounderInquiryForm() {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const form = event.currentTarget;

    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const formData = new FormData(form);
    const name = String(formData.get('name') ?? '').trim();
    const companyOrRole = String(formData.get('companyOrRole') ?? '').trim();
    const contact = String(formData.get('contact') ?? '').trim();
    const challenge = String(formData.get('challenge') ?? '').trim();

    const subject = `Founder AI 诊断申请 | ${name} | ${companyOrRole}`;
    const body = [
      '您好，',
      '',
      '我想申请 Founder AI 系统诊断。',
      '',
      `姓名：${name}`,
      `公司或身份：${companyOrRole}`,
      `联系方式：${contact}`,
      '',
      '当前最想解决的问题：',
      challenge,
      '',
      '谢谢。',
    ].join('\n');
    const mailtoUrl = `mailto:${INQUIRY_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    window.location.href = mailtoUrl;
  };

  return (
    <form className="founder-inquiry-form" onSubmit={handleSubmit}>
      <fieldset className="founder-inquiry-form__fields">
        <legend className="founder-inquiry-form__legend">申请诊断</legend>

        <div className="founder-inquiry-form__field">
          <label className="founder-inquiry-form__label" htmlFor="founder-inquiry-name">
            姓名 <span aria-hidden="true">*</span>
          </label>
          <input
            autoComplete="name"
            className="founder-inquiry-form__input"
            id="founder-inquiry-name"
            name="name"
            required
            type="text"
          />
        </div>

        <div className="founder-inquiry-form__field">
          <label className="founder-inquiry-form__label" htmlFor="founder-inquiry-company-or-role">
            公司或身份 <span aria-hidden="true">*</span>
          </label>
          <input
            autoComplete="organization"
            className="founder-inquiry-form__input"
            id="founder-inquiry-company-or-role"
            name="companyOrRole"
            required
            type="text"
          />
        </div>

        <div className="founder-inquiry-form__field">
          <label className="founder-inquiry-form__label" htmlFor="founder-inquiry-contact">
            联系方式 <span aria-hidden="true">*</span>
          </label>
          <input
            className="founder-inquiry-form__input"
            id="founder-inquiry-contact"
            name="contact"
            required
            type="text"
          />
        </div>

        <div className="founder-inquiry-form__field">
          <label className="founder-inquiry-form__label" htmlFor="founder-inquiry-challenge">
            当前最想解决的问题 <span aria-hidden="true">*</span>
          </label>
          <textarea
            className="founder-inquiry-form__textarea"
            id="founder-inquiry-challenge"
            name="challenge"
            required
            rows={6}
          />
        </div>
      </fieldset>

      <div className="founder-inquiry-form__actions">
        <button className="founder-inquiry-form__submit" type="submit">
          申请诊断
        </button>
        <p className="founder-inquiry-form__fallback">
          或直接邮件至{' '}
          <a className="founder-inquiry-form__fallback-link" href={`mailto:${INQUIRY_EMAIL}`}>
            {INQUIRY_EMAIL}
          </a>
        </p>
      </div>
    </form>
  );
}
