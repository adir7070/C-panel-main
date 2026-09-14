import { Component, type ReactNode } from "react";

interface Props { children: ReactNode; fallback?: (err: Error, reset: () => void) => ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div className="shell-content" style={{ maxWidth: 720 }}>
        <p className="t-eyebrow" style={{ color: "var(--negative)" }}>שגיאה</p>
        <h1 className="t-headline" style={{ marginTop: "var(--s-3)" }}>משהו השתבש</h1>
        <p className="t-body" style={{ marginTop: "var(--s-4)" }}>
          {error.message || "אירעה שגיאה לא צפויה."}
        </p>
        <div style={{ marginTop: "var(--s-6)", display: "flex", gap: "var(--s-3)" }}>
          <button className="btn" onClick={this.reset}>נסה שוב</button>
          <button className="btn btn-ghost" onClick={() => location.reload()}>טען מחדש</button>
        </div>
      </div>
    );
  }
}
