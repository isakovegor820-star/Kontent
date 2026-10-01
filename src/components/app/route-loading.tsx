// Общий скелетон сегмента: пока данные экрана грузятся, каркас вместо пустоты.
export function RouteLoading() {
  return (
    <div className="animate-pulse space-y-4 p-6" aria-busy="true" aria-label="Загружаем экран">
      <div className="h-8 w-56 rounded-sm bg-line" />
      <div className="h-4 w-72 max-w-full rounded-sm bg-line" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="h-28 rounded-sm bg-line" />
        <div className="h-28 rounded-sm bg-line" />
        <div className="h-28 rounded-sm bg-line" />
      </div>
    </div>
  );
}
