import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Remounts the boundary (clearing the error) whenever this changes. */
  resetKey?: string | null;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Render error in preview/coding panel:", error, info.componentStack);
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="panel-body">
          <div className="preview-unsupported">
            Something went wrong rendering this panel: {this.state.error.message}
            <div className="muted" style={{ marginTop: 8 }}>
              Select a different document, or check the console for details.
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
