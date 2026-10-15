/*
 * Estrutura pública: monta a aplicação depois do acesso.
 *
 * Esta página não traz conteúdo nenhum — nem texto, nem logo, nem código da
 * aplicação. Depois que o acesso é liberado (acesso.js ou onedrive-loader.js),
 * chega um pacote único com:
 *
 *   app.css   estilos       app.html   marcação       app.js   lógica
 *   app.titulo                base / comparativo   dados
 *
 * e este arquivo injeta tudo na página.
 */
(function(){
'use strict';

var status = document.getElementById('shellStatus');
var texto = document.getElementById('shellStatusTexto');
var acao = document.getElementById('shellStatusAcao');

function progresso(msg){
  status.className = 'shell-status';
  texto.textContent = msg;
  acao.innerHTML = '';
}

function falha(msg){
  status.className = 'shell-status erro';
  texto.textContent = msg;
  acao.innerHTML = '<button type="button" class="shell-botao" id="shellTentar">Entrar novamente</button>';
  document.getElementById('shellTentar').addEventListener('click', function(){
    if (typeof window.FONTE_REMOTA_LOGIN === 'function') window.FONTE_REMOTA_LOGIN();
    else window.location.reload();
  });
}

function montar(pacote){
  var app = pacote && pacote.app;
  if (!app || !app.html || !app.js) throw new Error('pacote sem a aplicação.');

  // Dados primeiro: a aplicação lê estas variáveis ao iniciar.
  window.DADOS_EMBUTIDOS = pacote.base;
  window.COMPARATIVO_EMBUTIDO = pacote.comparativo || null;

  if (app.css){
    var estilo = document.createElement('style');
    estilo.textContent = app.css;
    document.head.appendChild(estilo);
  }
  if (app.titulo) document.title = app.titulo;

  status.remove();
  document.body.insertAdjacentHTML('afterbegin', app.html);

  var script = document.createElement('script');
  script.textContent = app.js;
  document.body.appendChild(script);

  if (typeof window.FONTE_REMOTA_POS_MONTAGEM === 'function') window.FONTE_REMOTA_POS_MONTAGEM();
}

function iniciar(){
  if (typeof window.FONTE_REMOTA !== 'function'){
    falha('Configuração de acesso ausente.');
    return;
  }
  window.FONTE_REMOTA(progresso)
    .then(function(r){
      if (!r) return;                    // saiu para a tela de login externa
      progresso('Abrindo…');
      montar(r.pacote);
    })
    .catch(function(e){
      console.error(e);
      falha('Não foi possível abrir: ' + (e && e.message ? e.message : e));
    });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
else iniciar();

})();
