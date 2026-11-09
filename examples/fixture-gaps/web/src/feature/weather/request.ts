// 天気は外部のサービスから取る（この API は自前の OpenAPI に無い）
export type Weather = {
  condition: string;
  temperature: number;
};

export async function getWeather(): Promise<Weather> {
  const res = await fetch('https://api.example-weather.test/v1/today');
  return (await res.json()) as Weather;
}
