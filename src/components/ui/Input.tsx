import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  boxed?: boolean;
}

export function Input({ boxed, className = "", ...rest }: InputProps) {
  const cls = ["input", boxed ? "input-boxed" : "", className].filter(Boolean).join(" ");
  return <input {...rest} className={cls} />;
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  boxed?: boolean;
}

export function Textarea({ boxed, className = "", rows = 4, ...rest }: TextareaProps) {
  const cls = ["input", boxed ? "input-boxed" : "", className].filter(Boolean).join(" ");
  return <textarea {...rest} className={cls} rows={rows} />;
}
