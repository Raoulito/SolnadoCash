// app/src/hooks/useClusterGate.ts
//
// React view of the anti-mainnet gate in utils/clusterGate.ts.
//
// `checking` is deliberately NOT treated as usable by callers: until the cluster is positively
// identified, an action could be landing on mainnet. Components should enable actions only on
// `allowed`, which makes the initial render state safe by default.
//
// This hook is for the interface — disabling buttons, showing the banner. It is not the guard.
// The guard is `assertClusterAllowed` called inside each action handler, because UI state can be
// stale, raced, or bypassed, and a disabled button is a hint rather than an enforcement.

import { useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { verifyCluster } from '../utils/clusterGate';

export type ClusterState =
  | { status: 'checking' }
  | { status: 'allowed'; cluster: string }
  | {
      status: 'blocked';
      code: 'wrong-cluster' | 'unverified';
      cluster: string | null;
      message: string;
    };

export function useClusterGate(): ClusterState {
  const { connection } = useConnection();
  const [state, setState] = useState<ClusterState>({ status: 'checking' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'checking' });

    verifyCluster(connection)
      .then((verdict) => {
        if (cancelled) return;
        setState(
          verdict.ok
            ? { status: 'allowed', cluster: verdict.cluster }
            : {
                status: 'blocked',
                code: verdict.code,
                cluster: verdict.cluster,
                message: verdict.message,
              }
        );
      })
      .catch((err: unknown) => {
        // verifyCluster is written not to reject. If that ever changes, resolve to blocked
        // rather than leaving the UI stuck in `checking` with an unhandled rejection.
        if (cancelled) return;
        setState({
          status: 'blocked',
          code: 'unverified',
          cluster: null,
          message: `Could not check which network this app is on (${
            err instanceof Error ? err.message : String(err)
          }). Actions are blocked.`,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [connection]);

  return state;
}
