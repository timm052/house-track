// If a page throws while rendering, show a way out instead of a blank screen. The usual cause is a copy of
// a page saved for offline use by an older version of the app, so "Reload" also clears that saved copy.
import { Component, type ReactNode } from "react";
import { del } from "idb-keyval";

type State = { error: Error | null };

export default class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    // Navigating to another page gives it a fresh try.
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Something went wrong on this page</h2>
        <p className="small muted">{this.state.error.message}</p>
        <div className="row">
          <button className="primary" onClick={async () => { try { await del("housetrack.cache"); } catch { /* ignore */ } location.reload(); }}>
            Reload
          </button>
          <a href="/">Back to houses</a>
        </div>
      </div>
    );
  }
}
