import OrgWrapper from './wrapper';

export default function OrgCatchAll() {
  return <OrgWrapper />;
}

export function generateStaticParams() {
  return [{ path: [] }];
}
