// Regras puras de validação do deslocamento dos veículos.
// Uma leitura isolada muito distante costuma ser erro de GPS/map matching.
export const VELOCIDADE_MAX_M_S = 25; // 90 km/h: teto visual razoável para ônibus urbano.

export function limiteDeslocamento(intervaloS = 15, tempoDesdeLeituraMs = 0) {
  const janelaS = Math.max(Number(intervaloS) || 15, (Number(tempoDesdeLeituraMs) || 0) / 1000);
  return Math.max(140, janelaS * VELOCIDADE_MAX_M_S + 35);
}

export function movimentoPlausivel(distanciaM, intervaloS = 15, tempoDesdeLeituraMs = 0) {
  return Number.isFinite(distanciaM) && distanciaM <= limiteDeslocamento(intervaloS, tempoDesdeLeituraMs);
}

export function confirmaNovaArea(pendente, novaPosicao, distanciaEntre, toleranciaM = 220) {
  return Boolean(pendente) && distanciaEntre(pendente, novaPosicao) <= toleranciaM;
}
