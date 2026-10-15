/*
 * Estrutura pública: acesso por código.
 *
 * Tela inicial: e-mail -> código de 6 dígitos por e-mail -> pacote liberado.
 * Toda a decisão é do SERVIDOR (fluxo do Power Automate): a lista de e-mails,
 * o código, a validade e o pacote ficam no OneDrive e nunca vêm para este
 * arquivo. O navegador só conversa com o fluxo:
 *
 *   acao=solicitar  email          -> envia o código (resposta igual para
 *                                     e-mail liberado ou não)
 *   acao=validar    email, codigo  -> { ok, token, expira, arquivo }
 *   acao=dados      token          -> { ok, arquivo }   (sessão já aberta)
 *   acao=sair       token          -> encerra a sessão
 *
 * `arquivo` = pacote .json.gz em base64. Corpo em
 * application/x-www-form-urlencoded: requisição "simples", sem preflight CORS.
 */
(function(){
'use strict';

var CFG = window.JAMSTACK_CONFIG || {};
var LS_SESSAO = 'app.sessao';
var ESPERA_REENVIO = 60;   // segundos

/* ----------------------------------------------------------
   Utilitários
   ---------------------------------------------------------- */
function erro(msg, extra){
  var e = new Error(msg);
  if (extra) Object.keys(extra).forEach(function(k){ e[k] = extra[k]; });
  return e;
}
function lerSessao(){
  try {
    var s = JSON.parse(localStorage.getItem(LS_SESSAO) || 'null');
    if (s && s.token && Number(s.expira) * 1000 > Date.now()) return s;
  } catch (e) { /* storage bloqueado */ }
  return null;
}
function gravarSessao(s){
  try {
    if (s) localStorage.setItem(LS_SESSAO, JSON.stringify(s));
    else localStorage.removeItem(LS_SESSAO);
  } catch (e) { /* sem storage: a sessão vale só nesta aba */ }
}
function dataHoraBR(v){
  if (v === undefined || v === null || v === '') return '—';
  var d = typeof v === 'number' || /^\d+$/.test(String(v)) ? new Date(Number(v) * 1000) : new Date(v);
  if (isNaN(d)) return String(v);
  return d.toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
}
function emailValido(e){ return /^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/.test(e); }

/* ----------------------------------------------------------
   Servidor (fluxo do Power Automate)
   ---------------------------------------------------------- */
function chamar(campos){
  var corpo = new URLSearchParams({ acao: '', email: '', codigo: '', token: '' });
  Object.keys(campos).forEach(function(k){ corpo.set(k, campos[k]); });

  return fetch(CFG.fluxoUrl, { method: 'POST', body: corpo, cache: 'no-store' })
    .catch(function(){
      throw erro('não foi possível falar com o servidor de acesso. Verifique a conexão e tente de novo.');
    })
    .then(function(resp){
      return resp.text().then(function(texto){
        var json = {};
        try { json = texto ? JSON.parse(texto) : {}; } catch (e) { json = {}; }
        json._status = resp.status;
        return json;
      });
    });
}

/* base64 -> bytes -> (gzip?) -> JSON do payload */
function abrirArquivo(b64){
  if (!b64 || typeof b64 !== 'string') return Promise.reject(erro('o servidor não devolveu a base.'));
  var bin = atob(b64.replace(/\s/g, ''));
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  var gz = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  var json = !gz
    ? Promise.resolve(JSON.parse(new TextDecoder('utf-8').decode(bytes)))
    : (typeof DecompressionStream === 'undefined'
        ? Promise.reject(erro('este navegador não tem DecompressionStream (use Edge/Chrome atualizados).'))
        : new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json());

  return json.then(function(p){
    if (!p || !p.app || !p.base || !p.base.col || !p.base.n) {
      throw erro('o servidor devolveu um pacote inválido.');
    }
    return p;
  });
}

function entregar(payload, sessao){
  window.FONTE_REMOTA_INFO = {
    rotulo: 'publicado em ' + dataHoraBR(payload.gerado_em),
    titulo: 'Acesso: ' + (sessao.email || '') + ' · sessão válida até ' + dataHoraBR(sessao.expira) +
            (payload.versao ? ' · ' + payload.versao : '')
  };
  window.FONTE_REMOTA_POS_MONTAGEM = function(){ botaoSair(sessao); };
  return { pacote: payload, base: payload.base, comparativo: payload.comparativo || null };
}

function botaoSair(sessao){
  var ferramentas = document.querySelector('.topbar-tools');
  if (!ferramentas || document.getElementById('btnSair')) return;
  var b = document.createElement('button');
  b.type = 'button';
  b.id = 'btnSair';
  b.className = 'btn-sair';
  b.textContent = 'Sair';
  b.title = 'Encerrar a sessão' + (sessao.email ? ' de ' + sessao.email : '');
  b.addEventListener('click', window.FONTE_REMOTA_LOGIN);
  ferramentas.insertBefore(b, ferramentas.firstChild);
}

/* ----------------------------------------------------------
   Tela de acesso
   ---------------------------------------------------------- */
function abrirPortao(){
  return new Promise(function(resolve){
    document.documentElement.classList.add('acesso-bloqueado');

    var gate = document.createElement('div');
    gate.className = 'acesso-gate';
    gate.setAttribute('role', 'dialog');
    gate.setAttribute('aria-modal', 'true');
    gate.setAttribute('aria-labelledby', 'acessoTitulo');
    gate.innerHTML =
      '<div class="acesso-card">' +
        '<div class="acesso-icone" aria-hidden="true">' +
          '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
               'stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/>' +
               '<path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>' +
        '</div>' +
        '<h1 id="acessoTitulo">Acesso restrito</h1>' +
        '<p class="acesso-sub">Informe seu e-mail corporativo. Se ele estiver autorizado, você ' +
          'recebe um código de acesso.</p>' +

        '<form id="acessoFormEmail" novalidate>' +
          '<label for="acessoEmail">E-mail corporativo</label>' +
          '<input class="acesso-input" id="acessoEmail" type="email" inputmode="email" ' +
                 'autocomplete="email" placeholder="seu.email@empresa.com" required>' +
          '<button class="acesso-botao" type="submit">Enviar código</button>' +
        '</form>' +

        '<form id="acessoFormCodigo" hidden novalidate>' +
          '<p class="acesso-texto">Se <b id="acessoEmailMostrado"></b> estiver autorizado, você vai ' +
            'receber um código de 6 dígitos em instantes. Ele vale por 10 minutos.</p>' +
          '<div class="acesso-otp" id="acessoOtp" role="group" aria-label="Código de 6 dígitos">' +
            [0,1,2,3,4,5].map(function(i){
              return '<input type="text" inputmode="numeric" maxlength="1" pattern="[0-9]" ' +
                     (i === 0 ? 'autocomplete="one-time-code" ' : 'autocomplete="off" ') +
                     'aria-label="Dígito ' + (i + 1) + '">';
            }).join('') +
          '</div>' +
          '<button class="acesso-botao" type="submit">Entrar</button>' +
          '<div class="acesso-links">' +
            '<button class="acesso-link" type="button" id="acessoTrocar">← Trocar e-mail</button>' +
            '<button class="acesso-link" type="button" id="acessoReenviar">Reenviar código</button>' +
          '</div>' +
        '</form>' +

        '<p class="acesso-msg" id="acessoMsg" role="status" aria-live="polite"></p>' +
      '</div>';
    document.body.appendChild(gate);

    var formEmail = gate.querySelector('#acessoFormEmail');
    var formCodigo = gate.querySelector('#acessoFormCodigo');
    var campoEmail = gate.querySelector('#acessoEmail');
    var otp = gate.querySelector('#acessoOtp');
    var digitos = Array.prototype.slice.call(otp.querySelectorAll('input'));
    var msg = gate.querySelector('#acessoMsg');
    var btReenviar = gate.querySelector('#acessoReenviar');
    var email = '';
    var relogio = null;

    function aviso(texto, tipo){ msg.textContent = texto || ''; msg.className = 'acesso-msg' + (tipo ? ' ' + tipo : ''); }
    function ocupado(form, sim, rotulo){
      var b = form.querySelector('.acesso-botao');
      b.disabled = sim;
      if (rotulo) b.textContent = rotulo;
    }
    function codigo(){ return digitos.map(function(d){ return d.value; }).join(''); }
    function limparCodigo(){ digitos.forEach(function(d){ d.value = ''; }); digitos[0].focus(); }

    function contagem(){
      var resta = ESPERA_REENVIO;
      btReenviar.disabled = true;
      clearInterval(relogio);
      btReenviar.textContent = 'Reenviar em ' + resta + 's';
      relogio = setInterval(function(){
        resta--;
        if (resta <= 0){
          clearInterval(relogio);
          btReenviar.disabled = false;
          btReenviar.textContent = 'Reenviar código';
        } else {
          btReenviar.textContent = 'Reenviar em ' + resta + 's';
        }
      }, 1000);
    }

    function solicitar(){
      return chamar({ acao: 'solicitar', email: email }).then(function(r){
        if (r._status === 429) throw erro('muitos pedidos em sequência. Aguarde um minuto e tente de novo.');
        if (r._status >= 500) throw erro('o servidor de acesso está indisponível agora. Tente em alguns minutos.');
        if (r._status === 401 || r._status === 403) {
          throw erro('o servidor recusou o pedido (HTTP ' + r._status + '). Verifique se o gatilho aceita "Qualquer pessoa".');
        }
        if (r._status !== 200 || !r.ok) {
          throw erro('resposta inesperada do servidor (HTTP ' + r._status + (r.erro ? ', ' + r.erro : '') + ').');
        }
        // Resposta igual para e-mail liberado ou não: não revela quem está na lista.
      });
    }

    formEmail.addEventListener('submit', function(ev){
      ev.preventDefault();
      email = campoEmail.value.trim().toLowerCase();
      if (!emailValido(email)){ aviso('Digite um e-mail válido.', 'erro'); campoEmail.focus(); return; }
      aviso('');
      ocupado(formEmail, true, 'Enviando…');
      solicitar()
        .then(function(){
          gate.querySelector('#acessoEmailMostrado').textContent = email;
          formEmail.hidden = true;
          formCodigo.hidden = false;
          gate.querySelector('.acesso-sub').hidden = true;
          contagem();
          limparCodigo();
        })
        .catch(function(e){ aviso('Não foi possível enviar: ' + e.message, 'erro'); })
        .then(function(){ ocupado(formEmail, false, 'Enviar código'); });
    });

    // Caixas de dígito: avança, volta no backspace, aceita colar o código inteiro.
    digitos.forEach(function(d, i){
      d.addEventListener('input', function(){
        var v = d.value.replace(/\D/g, '');
        if (v.length > 1){ espalhar(v, i); return; }
        d.value = v;
        otp.classList.remove('erro');
        if (v && i < 5) digitos[i + 1].focus();
        if (codigo().length === 6) formCodigo.requestSubmit ? formCodigo.requestSubmit() : formCodigo.dispatchEvent(new Event('submit'));
      });
      d.addEventListener('keydown', function(ev){
        if (ev.key === 'Backspace' && !d.value && i > 0){ digitos[i - 1].focus(); digitos[i - 1].value = ''; }
        if (ev.key === 'ArrowLeft' && i > 0) digitos[i - 1].focus();
        if (ev.key === 'ArrowRight' && i < 5) digitos[i + 1].focus();
      });
      d.addEventListener('paste', function(ev){
        var t = (ev.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
        if (t){ ev.preventDefault(); espalhar(t, 0); }
      });
    });
    function espalhar(texto, de){
      texto.slice(0, 6 - de).split('').forEach(function(c, k){ digitos[de + k].value = c; });
      var prox = Math.min(de + texto.length, 5);
      digitos[prox].focus();
      if (codigo().length === 6) formCodigo.requestSubmit ? formCodigo.requestSubmit() : formCodigo.dispatchEvent(new Event('submit'));
    }

    var validando = false;
    formCodigo.addEventListener('submit', function(ev){
      ev.preventDefault();
      if (validando) return;
      var c = codigo();
      if (!/^\d{6}$/.test(c)){ aviso('Digite os 6 dígitos do código.', 'erro'); return; }
      validando = true;
      aviso('');
      ocupado(formCodigo, true, 'Validando…');

      chamar({ acao: 'validar', email: email, codigo: c })
        .then(function(r){
          if (r._status !== 200 && r._status !== 401){
            throw erro('o servidor de acesso falhou (HTTP ' + r._status + '). Tente de novo em instantes.');
          }
          if (r._status === 200 && !r.token){
            throw erro('o servidor respondeu sem a sessão. Avise o responsável.');
          }
          if (!r.ok || r._status !== 200){
            var e = erro(r.erro === 'expirado' ? 'código expirado. Peça um novo.'
                       : r.erro === 'bloqueado' ? 'tentativas esgotadas. Peça um novo código.'
                       : 'código incorreto.');
            e.codigo = true;
            throw e;
          }
          var sessao = { token: r.token, email: email, nome: r.nome || '', expira: Number(r.expira) || 0 };
          ocupado(formCodigo, true, 'Abrindo…');
          return abrirArquivo(r.arquivo).then(function(payload){
            gravarSessao(sessao);
            return entregar(payload, sessao);
          });
        })
        .then(function(dados){
          clearInterval(relogio);
          aviso('Acesso liberado.', 'ok');
          gate.classList.add('saindo');
          document.documentElement.classList.remove('acesso-bloqueado');
          setTimeout(function(){ gate.remove(); }, 400);
          resolve(dados);
        })
        .catch(function(e){
          if (e.codigo){ otp.classList.add('erro'); limparCodigo(); }
          aviso((e.codigo ? 'Não deu: ' : 'Erro: ') + e.message, 'erro');
          ocupado(formCodigo, false, 'Entrar');
        })
        .then(function(){ validando = false; });
    });

    btReenviar.addEventListener('click', function(){
      aviso('Enviando um novo código…');
      solicitar()
        .then(function(){ aviso('Novo código enviado. O anterior deixou de valer.', 'ok'); contagem(); limparCodigo(); })
        .catch(function(e){ aviso('Não foi possível reenviar: ' + e.message, 'erro'); });
    });

    gate.querySelector('#acessoTrocar').addEventListener('click', function(){
      clearInterval(relogio);
      formCodigo.hidden = true;
      formEmail.hidden = false;
      gate.querySelector('.acesso-sub').hidden = false;
      aviso('');
      campoEmail.focus();
      campoEmail.select();
    });

    campoEmail.focus();
  });
}

/* ----------------------------------------------------------
   Contrato com o shell.js
   ---------------------------------------------------------- */
window.FONTE_REMOTA = function(progresso){
  progresso = progresso || function(){};
  if (!CFG.fluxoUrl){
    return Promise.reject(erro('config.js incompleto — falta fluxoUrl (URL do fluxo do Power Automate). ' +
                               'Preencha FLUXO_URL no script de publicação e publique de novo.'));
  }

  var sessao = lerSessao();
  if (!sessao) return abrirPortao();

  progresso('Abrindo sua sessão…');
  return chamar({ acao: 'dados', token: sessao.token })
    .then(function(r){
      if (!r.ok || r._status !== 200){ gravarSessao(null); return abrirPortao(); }
      progresso('Abrindo…');
      return abrirArquivo(r.arquivo).then(function(p){ return entregar(p, sessao); });
    });
};

window.FONTE_REMOTA_LOGIN = function(){
  var s = lerSessao();
  gravarSessao(null);
  // Avisa o servidor para derrubar o token (melhor esforço; não espera).
  if (s && CFG.fluxoUrl) { try { chamar({ acao: 'sair', token: s.token }); } catch (e) {} }
  setTimeout(function(){ window.location.reload(); }, 150);
};

})();
