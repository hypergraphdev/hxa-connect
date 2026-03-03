import DashboardCatchAll from './client';

export function generateStaticParams() {
  return [{ path: [] }];
}

export default function DashboardPage() {
  return <DashboardCatchAll />;
}
