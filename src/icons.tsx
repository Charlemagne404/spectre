const paths = {
  back: 'M14 8H3m0 0 4-4M3 8l4 4',
  open: 'M2 5V3h5l2 2h5v2M2 5v8h11l2-6H4l-2 6',
  left: 'm10 3-5 5 5 5',
  right: 'm6 3 5 5-5 5',
  search: 'M10.5 10.5 14 14M12 7a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z',
  copy: 'M5 5h8v9H5zM3 11H2V2h8v1',
  jump: 'M3 8h9m-4-4 4 4-4 4m6-9v10',
  check: 'm3 8 3 3 7-7',
  close: 'm4 4 8 8M12 4l-8 8',
} as const;

export function Icon({ name }: { name: keyof typeof paths }) {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d={paths[name]} stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}
