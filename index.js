const Web3 = require('web3');
const axios = require('axios');
const { Solver } = require('2captcha');
const winston = require('winston');
const readline = require('readline');
const colors = require('colors');
const fs = require('fs').promises;
const path = require('path');
const rotatingFileStream = require('rotating-file-stream');

// Cấu hình mạng 0G-Galileo-Testnet
const CHAIN_CONFIG = {
  chainName: '0G-Galileo-Testnet',
  chainId: 16601,
  tokenSymbol: 'OG',
  rpcUrl: 'https://evmrpc-testnet.0g.ai',
  explorerUrl: 'https://chainscan-galileo.0g.ai'
};

// Hợp đồng faucet
const FAUCET_CONTRACTS = {
  USDT: '0x3eC8A8705bE1D5ca90066b37ba62c4183B024ebf',
  ETH: '0x0fE9B43625fA7EdD663aDcEC0728DD635e4AbF7c',
  BTC: '0x36f6414FF1df609214dDAbA71c84f18bcf00F67d'
};

// Danh sách token hỗ trợ swap
const TOKENS = {
  USDT: { address: '0x3eC8A8705bE1D5ca90066b37ba62c4183B024ebf', decimals: 18 },
  BTC: { address: '0x36f6414FF1df609214dDAbA71c84f18bcf00F67d', decimals: 18 },
  ETH: { address: '0x0fE9B43625fA7EdD663aDcEC0728DD635e4AbF7c', decimals: 18 }
};

// ABI cho hàm mint
const MINT_ABI = [
  {
    name: 'mint',
    type: 'function',
    inputs: [],
    outputs: [],
    payable: true,
    signature: '0x1249c58b',
    stateMutability: 'payable'
  }
];

// ABI cho ERC20 (approve, balanceOf)
const ERC20_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'spender', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' }
    ],
    name: 'approve',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [{ internalType: 'address', name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  }
];

// ABI cho router swap
const ROUTER_ABI = [
  {
    inputs: [
      {
        components: [
          { internalType: 'address', name: 'tokenIn', type: 'address' },
          { internalType: 'address', name: 'tokenOut', type: 'address' },
          { internalType: 'uint24', name: 'fee', type: 'uint24' },
          { internalType: 'address', name: 'recipient', type: 'address' },
          { internalType: 'uint256', name: 'deadline', type: 'uint256' },
          { internalType: 'uint256', name: 'amountIn', type: 'uint256' },
          { internalType: 'uint256', name: 'amountOutMinimum', type: 'uint256' },
          { internalType: 'uint160', name: 'sqrtPriceLimitX96', type: 'uint160' }
        ],
        internalType: 'struct ISwapRouter.ExactInputSingleParams',
        name: 'params',
        type: 'tuple'
      }
    ],
    name: 'exactInputSingle',
    outputs: [{ internalType: 'uint256', name: 'amountOut', type: 'uint256' }],
    stateMutability: 'payable',
    type: 'function'
  }
];

// Cấu hình logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss | DD-MM-YYYY' }),
    winston.format.printf(({ timestamp, level, message }) => {
      const coloredLevel = level.toUpperCase() === 'INFO' ? colors.green(level.toUpperCase()) : colors.red(level.toUpperCase());
      return colors.cyan(`[${timestamp}]`) + colors.magenta(` [Crazyscholar @ 0G_Lab] `) + `[${coloredLevel}] | ` + colors.blue('Account') + ` - ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new rotatingFileStream('app.log', {
      path: './logs',
      size: '10M',
      interval: '1M',
      compress: 'gzip'
    })
  ]
});

// Tắt log của web3
function configuration() {
  const web3Logger = require('winston').loggers.get('web3');
  if (web3Logger) web3Logger.level = 'warning';
}

// Hàm phân tích proxy
function parseProxy(proxyString) {
  if (!proxyString) return null;

  let proxy = proxyString.trim();
  let user, pass, host, port;

  // Xử lý các định dạng
  if (proxy.startsWith('http://')) {
    // Định dạng: http://user:pass@host:port
    proxy = proxy.replace('http://', '');
    const [auth, hostPort] = proxy.split('@');
    if (hostPort) {
      [user, pass] = auth.split(':');
      [host, port] = hostPort.split(':');
    } else {
      // Chỉ có host:port
      [host, port] = proxy.split(':');
    }
  } else {
    // Định dạng: user:pass@host:port hoặc host:port
    const [auth, hostPort] = proxy.split('@');
    if (hostPort) {
      [user, pass] = auth.split(':');
      [host, port] = hostPort.split(':');
    } else {
      [host, port] = proxy.split(':');
    }
  }

  if (!host || !port) {
    logger.error(`Định dạng proxy không hợp lệ: ${proxyString}`);
    return null;
  }

  return { host, port: parseInt(port), auth: user && pass ? { username: user, password: pass } : undefined };
}

// Hàm retry
const retryAsync = (fn, maxRetries, delay) => async (...args) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn(...args);
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      const pause = Math.floor(Math.random() * (delay[1] - delay[0] + 1)) + delay[0];
      logger.warn(`Thử lại lần ${i + 1}/${maxRetries} sau ${pause}s...`);
      await new Promise(resolve => setTimeout(resolve, pause * 1000));
    }
  }
};

// Đọc file
async function readFileLines(filePath) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return data.split('\n').map(line => line.trim()).filter(line => line);
  } catch (err) {
    logger.error(`Lỗi đọc file ${filePath}: ${err.message}`);
    return [];
  }
}

// Ghi file twitter_tokens.txt
async function updateTwitterTokens(filePath, oldToken, newToken) {
  try {
    let tokens = await readFileLines(filePath);
    tokens = tokens.filter(t => t !== oldToken);
    if (newToken) tokens.push(newToken);
    await fs.writeFile(filePath, tokens.join('\n') + '\n');
    logger.info(`Đã cập nhật twitter_tokens.txt`);
  } catch (err) {
    logger.error(`Lỗi cập nhật ${filePath}: ${err.message}`);
    throw err;
  }
}

// Đọc cấu hình
async function loadConfig() {
  try {
    const data = await fs.readFile('config.json', 'utf8');
    return JSON.parse(data);
  } catch (err) {
    logger.error(`Lỗi đọc config.json: ${err.message}`);
    throw err;
  }
}

// Khởi tạo Web3
function initWeb3() {
  const web3 = new Web3(CHAIN_CONFIG.rpcUrl);
  return web3;
}

// Hiển thị logo
function showLogo() {
  // Xóa màn hình
  const clear = require('os').platform() === 'win32' ? 'cls' : 'clear';
  require('child_process').execSync(clear, { stdio: 'inherit' });

  const logo = `
 ▄████▄   ██▀███   ▄▄▄      ▒███████▒▓██   ██▓  ██████  ▄████▄   ██░ ██  ▒█████   ██▓    ▄▄▄       ██▀███  
▒██▀ ▀█  ▓██ ▒ ██▒▒████▄    ▒ ▒ ▒ ▄▀░ ▒██  ██▒▒██    ▒ ▒██▀ ▀█  ▓██░ ██▒▒██▒  ██▒▓██▒   ▒████▄    ▓██ ▒ ██▒
▒▓█    ▄ ▓██ ░▄█ ▒▒██  ▀█▄  ░ ▒ ▄▀▒░   ▒██ ██░░ ▓██▄   ▒▓█    ▄ ▒██▀▀██░▒██░  ██▒▒██░   ▒██  ▀█▄  ▓██ ░▄█ ▒
▒▓▓▄ ▄██▒▒██▀▀█▄  ░██▄▄▄▄██   ▄▀▒   ░  ░ ▐██▓░  ▒   ██▒▒▓▓▄ ▄██▒░▓█ ░██ ▒██   ██░▒██░   ░██▄▄▄▄██ ▒██▀▀█▄  
▒ ▓███▀ ░░██▓ ▒██▒ ▓█   ▓██▒▒███████▒  ░ ██▒▓░▒██████▒▒▒ ▓███▀ ░░▓█▒░██▓░ ████▓▒░░██████▒▓█   ▓██▒░██▓ ▒██▒
░ ░▒ ▒  ░░ ▒▓ ░▒▓░ ▒▒   ▓▒█░░▒▒ ▓░▒░▒   ██▒▒▒ ▒ ▒▓▒ ▒ ░░ ░▒ ▒  ░ ▒ ░░▒░▒░ ▒░▒░▒░ ░ ▒░▓  ░▒▒   ▓▒█░░ ▒▓ ░▒▓░
  ░  ▒     ░▒ ░ ▒░  ▒   ▒▒ ░░░▒ ▒ ░ ▒ ▓██ ░▒░ ░ ░▒  ░ ░  ░  ▒    ▒ ░▒░ ░  ░ ▒ ▒░ ░ ░ ▒  ░ ▒   ▒▒ ░  ░▒ ░ ▒░
░          ░░   ░   ░   ▒   ░ ░ ░ ░ ░ ▒ ▒ ░░  ░  ░  ░  ░         ░  ░░ ░░ ░ ░ ▒    ░ ░    ░   ▒     ░░   ░ 
░ ░         ░           ░  ░  ░ ░     ░ ░           ░  ░ ░       ░  ░  ░    ░ ░      ░  ░     ░  ░   ░     
░                           ░         ░ ░              ░                                                   
`;
  console.log(colors.cyan(logo));
}

// Kết nối Twitter
const connectTwitter = retryAsync(async (accountIndex, twitterToken, proxy, config) => {
  logger.info(`${accountIndex} | Đang kết nối Twitter...`);

  const headers = {
    'sec-ch-ua-platform': '"Windows"',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    'accept': '*/*',
    'origin': 'https://faucet.0g.ai',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'referer': 'https://faucet.0g.ai/',
    'accept-language': 'vi,en-US;q=0.9,en;q=0.8',
    'authorization': `Bearer ${twitterToken}`
  };

  const axiosConfig = {
    headers,
    proxy: proxy ? {
      host: proxy.host,
      port: proxy.port,
      auth: proxy.auth
    } : false
  };

  try {
    // Bước 1: Yêu cầu oauth_token từ faucet
    const response = await axios.post('https://faucet.0g.ai/api/request-token', { domain: '0g' }, axiosConfig);
    const oauthToken = response.data.url?.split('oauth_token=')[1]?.split('&')[0];
    if (!oauthToken) {
      logger.error(`${accountIndex} | Không tìm thấy oauth_token trong response`);
      throw new Error('Không tìm thấy oauth_token');
    }

    // Bước 2: Gửi yêu cầu xác thực tới Twitter
    const authResponse = await axios.get('https://api.x.com/oauth/authenticate', {
      params: { oauth_token: oauthToken },
      headers: {
        ...headers,
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-user': '?1',
        'sec-fetch-dest': 'document',
        'referer': 'https://faucet.0g.ai/'
      },
      proxy: proxy ? {
        host: proxy.host,
        port: proxy.port,
        auth: proxy.auth
      } : false
    });

    if (authResponse.data.includes('Could not authenticate you') || authResponse.data.includes('Invalid')) {
      logger.error(`${accountIndex} | Twitter token không hợp lệ`);
      if (!config.spareTwitterTokens || config.spareTwitterTokens.length === 0) {
        throw new Error('Twitter token không hợp lệ và không còn token dự phòng');
      }
      const newToken = config.spareTwitterTokens.shift();
      await updateTwitterTokens('twitter_tokens.txt', twitterToken, newToken);
      return await connectTwitter(accountIndex, newToken, proxy, config);
    }

    // Bước 3: Trích xuất oauth_verifier từ response
    const oauthVerifierMatch = authResponse.data.match(/oauth_verifier=([^&]+)/);
    if (!oauthVerifierMatch) {
      logger.error(`${accountIndex} | Không tìm thấy oauth_verifier`);
      throw new Error('Không tìm thấy oauth_verifier');
    }
    const oauthVerifier = oauthVerifierMatch[1];

    // Bước 4: Hoàn tất xác thực với faucet
    const finalResponse = await axios.get('https://faucet.0g.ai/', {
      params: { oauth_token: oauthToken, oauth_verifier: oauthVerifier },
      headers: {
        ...headers,
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        'referer': 'https://x.com/'
      },
      proxy: proxy ? {
        host: proxy.host,
        port: proxy.port,
        auth: proxy.auth
      } : false
    });

    logger.info(`${accountIndex} | Kết nối Twitter thành công`);
    return { oauthToken, oauthVerifier };
  } catch (err) {
    logger.error(`${accountIndex} | Lỗi kết nối Twitter: ${err.message}`);
    throw err;
  }
}, 3, [5, 10]);

// Giải hCaptcha bằng 2Captcha
const solveCaptcha = retryAsync(async (accountIndex, config, proxy) => {
  logger.info(`${accountIndex} | Đang giải hCaptcha bằng 2Captcha...`);

  const solver = new Solver(config.captcha.apiKey);
  try {
    const proxyUrl = proxy ? `http://${proxy.auth ? `${proxy.auth.username}:${proxy.auth.password}@` : ''}${proxy.host}:${proxy.port}` : undefined;
    const result = await solver.hcaptcha({
      pageurl: 'https://faucet.0g.ai/',
      sitekey: '914e63b4-ac20-4c24-bc92-cdb6950ccfde',
      proxy: proxyUrl,
      proxytype: proxy ? 'HTTP' : undefined
    });

    if (!result.data) {
      throw new Error('Không nhận được token CAPTCHA');
    }

    logger.info(`${accountIndex} | Đã giải hCaptcha thành công`);
    return result.data;
  } catch (err) {
    logger.error(`${accountIndex} | Lỗi giải CAPTCHA: ${err.message}`);
    throw err;
  }
}, 3, [5, 10]);

// Nhận faucet 0G
const defaultFaucet = retryAsync(async (accountIndex, web3, config, wallet, proxy, oauthToken, oauthVerifier) => {
  logger.info(`${accountIndex} | Bắt đầu nhận faucet 0G...`);

  const captchaToken = await solveCaptcha(accountIndex, config, proxy);

  const headers = {
    'sec-ch-ua-platform': '"Windows"',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Google Chrome";v="131", "Not-A.Brand";v="8", "Chromium";v="131"',
    'content-type': 'text/plain;charset=UTF-8',
    'accept': '*/*',
    'origin': 'https://faucet.0g.ai',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'referer': `https://faucet.0g.ai/?oauth_token=${oauthToken}&oauth_verifier=${oauthVerifier}`,
    'accept-language': 'vi,en-US;q=0.9,en;q=0.8'
  };

  try {
    const response = await axios.post('https://faucet.0g.ai/api/faucet', {
      address: wallet.address,
      hcaptchaToken: captchaToken,
      oauth_token: oauthToken,
      oauth_verifier: oauthVerifier
    }, {
      headers,
      proxy: proxy ? {
        host: proxy.host,
        port: proxy.port,
        auth: proxy.auth
      } : false
    });

    if (response.data.includes('hours before requesting again') || response.data.includes('Please wait 24 hours')) {
      logger.info(`${accountIndex} | Đã nhận faucet 0G hôm nay rồi. Vui lòng chờ 24h.`);
      return true;
    }

    if (response.data.includes('Internal Server Error') || response.data.includes('Service is busy')) {
      throw new Error('Faucet lỗi hoặc đang bận');
    }

    if (response.data.includes('Invalid Captcha')) {
      throw new Error('Captcha không hợp lệ');
    }

    if (response.status === 200) {
      logger.info(`${accountIndex} | Nhận faucet 0G thành công`);
      return true;
    }

    throw new Error(`Lỗi không xác định: ${response.status} | ${response.data}`);
  } catch (err) {
    logger.error(`${accountIndex} | Lỗi nhận faucet 0G: ${err.message}`);
    throw err;
  }
}, 3, [5, 10]);

// Mint token từ hợp đồng faucet
const mintToken = retryAsync(async (accountIndex, web3, wallet, tokenName, contractAddress, config) => {
  logger.info(`${accountIndex} | Bắt đầu mint ${tokenName}...`);

  try {
    const contract = new web3.eth.Contract(MINT_ABI, contractAddress);
    const gasPrice = await web3.eth.getGasPrice();
    const gasParams = { gasPrice };

    const tx = {
      from: wallet.address,
      to: contractAddress,
      data: contract.methods.mint().encodeABI(),
      value: '0',
      nonce: await web3.eth.getTransactionCount(wallet.address, 'pending'),
      chainId: CHAIN_CONFIG.chainId,
      ...gasParams
    };

    const gasEstimate = await web3.eth.estimateGas(tx).catch(err => {
      throw new Error(`Lỗi ước lượng gas: ${err.message}`);
    });
    tx.gas = gasEstimate;

    const signedTx = await web3.eth.accounts.signTransaction(tx, wallet.privateKey);
    const txReceipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);

    if (txReceipt.status) {
      logger.info(`${accountIndex} | Mint ${tokenName} thành công | Tx: ${CHAIN_CONFIG.explorerUrl}/tx/${txReceipt.transactionHash}`);
      return true;
    }

    throw new Error('Giao dịch mint thất bại');
  } catch (err) {
    if (err.message.includes('Wait 24 hours')) {
      logger.info(`${accountIndex} | Đã mint ${tokenName} hôm nay rồi. Vui lòng chờ 24h.`);
      return true;
    }
    logger.error(`${accountIndex} | Lỗi mint ${tokenName}: ${err.message}`);
    throw err;
  }
}, 3, [5, 10]);

// Mint tất cả token
const faucetTokens = retryAsync(async (accountIndex, web3, config, wallet) => {
  logger.info(`${accountIndex} | Bắt đầu nhận faucet token...`);

  try {
    const balance = await web3.eth.getBalance(wallet.address);
    if (web3.utils.fromWei(balance, 'ether') < 0.00001) {
      logger.error(`${accountIndex} | Số dư OG không đủ (< 0.00001 OG). Hãy chạy faucet trước.`);
      return false;
    }

    let successMinted = 0;
    for (const [tokenName, contractAddress] of Object.entries(FAUCET_CONTRACTS)) {
      try {
        const success = await mintToken(accountIndex, web3, wallet, tokenName, contractAddress, config);
        if (success) {
          successMinted++;
          logger.info(`${accountIndex} | Đã nhận ${tokenName} thành công`);
        } else {
          logger.error(`${accountIndex} | Nhận ${tokenName} thất bại`);
        }
      } catch (err) {
        logger.error(`${accountIndex} | Lỗi khi nhận ${tokenName}: ${err.message}`);
        continue;
      } finally {
        const pause = Math.floor(Math.random() * (config.settings.pauseBetweenSwaps[1] - config.settings.pauseBetweenSwaps[0] + 1)) + config.settings.pauseBetweenSwaps[0];
        logger.info(`${accountIndex} | Dừng ${pause} giây sau khi thử nhận ${tokenName}...`);
        await new Promise(resolve => setTimeout(resolve, pause * 1000));
      }
    }

    if (successMinted >= 1) {
      logger.info(`${accountIndex} | Đã nhận thành công ${successMinted}/${Object.keys(FAUCET_CONTRACTS).length} token`);
      return true;
    } else {
      logger.error(`${accountIndex} | Không nhận được token nào`);
      return false;
    }
  } catch (err) {
    logger.error(`${accountIndex} | Lỗi faucet token: ${err.message}`);
    throw err;
  }
}, 3, [5, 10]);

// Swap token
const swapTokens = retryAsync(async (accountIndex, web3, config, wallet, tokenInAddress, tokenOutAddress, amountIn, minAmountOut) => {
  logger.info(`${accountIndex} | Đang swap ${amountIn / 1e18} từ ${tokenInAddress} sang ${tokenOutAddress}...`);

  try {
    const tokenInSymbol = Object.keys(TOKENS).find(k => TOKENS[k].address.toLowerCase() === tokenInAddress.toLowerCase()) || 'Unknown';
    const tokenOutSymbol = Object.keys(TOKENS).find(k => TOKENS[k].address.toLowerCase() === tokenOutAddress.toLowerCase()) || 'Unknown';

    const balance = await web3.eth.getBalance(wallet.address);
    if (web3.utils.fromWei(balance, 'ether') < 0.00001) {
      throw new Error('Số dư OG không đủ để trả phí gas');
    }

    const routerAddress = '0xD86b764618c6E3C078845BE3c3fCe50CE9535Da7';
    const tokenContract = new web3.eth.Contract(ERC20_ABI, tokenInAddress);

    // Approve token
    const approveTx = {
      from: wallet.address,
      to: tokenInAddress,
      data: tokenContract.methods.approve(routerAddress, amountIn).encodeABI(),
      nonce: await web3.eth.getTransactionCount(wallet.address, 'pending'),
      chainId: CHAIN_CONFIG.chainId,
      gasPrice: await web3.eth.getGasPrice()
    };

    approveTx.gas = await web3.eth.estimateGas(approveTx);
    const signedApproveTx = await web3.eth.accounts.signTransaction(approveTx, wallet.privateKey);
    await web3.eth.sendSignedTransaction(signedApproveTx.rawTransaction);

    // Chuẩn bị giao dịch swap
    const routerContract = new web3.eth.Contract(ROUTER_ABI, routerAddress);
    const deadline = Math.floor(Date.now() / 1000) + 1800; // +30 phút
    const swapParams = {
      tokenIn: tokenInAddress,
      tokenOut: tokenOutAddress,
      fee: 3000, // 0.3%
      recipient: wallet.address,
      deadline,
      amountIn,
      amountOutMinimum: minAmountOut,
      sqrtPriceLimitX96: 0
    };

    const swapTx = {
      from: wallet.address,
      to: routerAddress,
      data: routerContract.methods.exactInputSingle(swapParams).encodeABI(),
      nonce: await web3.eth.getTransactionCount(wallet.address, 'pending'),
      chainId: CHAIN_CONFIG.chainId,
      gasPrice: await web3.eth.getGasPrice()
    };

    swapTx.gas = await web3.eth.estimateGas(swapTx);
    const signedSwapTx = await web3.eth.accounts.signTransaction(swapTx, wallet.privateKey);
    const txReceipt = await web3.eth.sendSignedTransaction(signedSwapTx.rawTransaction);

    if (txReceipt.status) {
      logger.info(`${accountIndex} | Swap thành công ${amountIn / 1e18} ${tokenInSymbol} -> ${tokenOutSymbol} | Tx: ${CHAIN_CONFIG.explorerUrl}/tx/${txReceipt.transactionHash}`);
      return true;
    }

    throw new Error('Giao dịch swap thất bại');
  } catch (err) {
    logger.error(`${accountIndex} | Lỗi swap token: ${err.message}`);
    throw err;
  }
}, 3, [5, 10]);

// Thực hiện swaps
const swaps = retryAsync(async (accountIndex, web3, config, wallet) => {
  logger.info(`${accountIndex} | Bắt đầu thực hiện swap...`);

  try {
    const balance = await web3.eth.getBalance(wallet.address);
    if (web3.utils.fromWei(balance, 'ether') < 0.00001) {
      throw new Error('Số dư OG không đủ để trả phí gas');
    }

    const tokenBalances = {};
    for (const [symbol, tokenData] of Object.entries(TOKENS)) {
      const contract = new web3.eth.Contract(ERC20_ABI, tokenData.address);
      const balance = await contract.methods.balanceOf(wallet.address).call();
      tokenBalances[symbol] = BigInt(balance);
      logger.info(`${accountIndex} | Số dư ${symbol}: ${balance / 1e18}`);
    }

    const tokensWithBalance = Object.keys(tokenBalances).filter(symbol => tokenBalances[symbol] > 0);
    if (!tokensWithBalance.length) {
      throw new Error('Không có token nào đủ số dư để swap');
    }

    const numSwaps = Math.floor(Math.random() * (config.settings.numberOfSwaps[1] - config.settings.numberOfSwaps[0] + 1)) + config.settings.numberOfSwaps[0];
    logger.info(`${accountIndex} | Sẽ thực hiện ${numSwaps} lần swap`);

    for (let i = 0; i < numSwaps; i++) {
      const validTokens = Object.keys(tokenBalances).filter(symbol => tokenBalances[symbol] > 0);
      if (!validTokens.length) {
        logger.warn(`${accountIndex} | Không còn token nào đủ số dư sau ${i} lần swap`);
        break;
      }

      const tokenInSymbol = validTokens[Math.floor(Math.random() * validTokens.length)];
      const tokenInBalance = tokenBalances[tokenInSymbol];
      const tokenInAddress = TOKENS[tokenInSymbol].address;

      let tokenOutSymbol;
      if (tokenInSymbol === 'USDT') {
        tokenOutSymbol = Math.random() < 0.5 ? 'ETH' : 'BTC';
      } else {
        tokenOutSymbol = 'USDT';
      }
      const tokenOutAddress = TOKENS[tokenOutSymbol].address;

      const swapPercent = Math.floor(Math.random() * (config.settings.balancePercentToSwap[1] - config.settings.balancePercentToSwap[0] + 1)) + config.settings.balancePercentToSwap[0];
      const amountToSwap = tokenInBalance * BigInt(swapPercent) / BigInt(100);

      logger.info(`${accountIndex} | Swap ${i + 1}/${numSwaps}: ${swapPercent}% ${tokenInSymbol} (${amountToSwap / 1e18}) -> ${tokenOutSymbol}`);

      await swapTokens(accountIndex, web3, config, wallet, tokenInAddress, tokenOutAddress, amountToSwap, 0);

      tokenBalances[tokenInSymbol] -= amountToSwap;
      const outContract = new web3.eth.Contract(ERC20_ABI, tokenOutAddress);
      tokenBalances[tokenOutSymbol] = BigInt(await outContract.methods.balanceOf(wallet.address).call());

      if (i < numSwaps - 1) {
        const pause = Math.floor(Math.random() * (config.settings.pauseBetweenSwaps[1] - config.settings.pauseBetweenSwaps[0] + 1)) + config.settings.pauseBetweenSwaps[0];
        logger.info(`${accountIndex} | Dừng ${pause} giây trước lần swap tiếp theo...`);
        await new Promise(resolve => setTimeout(resolve, pause * 1000));
      }
    }

    return true;
  } catch (err) {
    logger.error(`${accountIndex} | Lỗi khi thực hiện swap: ${err.message}`);
    throw err;
  }
}, 3, [5, 10]);

// Triển khai storage scan
const deployStorageScan = retryAsync(async (accountIndex, web3, config, wallet) => {
  logger.info(`${accountIndex} | Bắt đầu triển khai storage scan...`);

  try {
    const balance = await web3.eth.getBalance(wallet.address);
    if (web3.utils.fromWei(balance, 'ether') < 0.00001) {
      throw new Error('Số dư OG không đủ để trả phí gas');
    }

    const contentHash = Buffer.from(Array(32).fill().map(() => Math.floor(Math.random() * 256)));
    const data = (
      '0xef3e12dc' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000014' +
      '0000000000000000000000000000000000000000000000000000000000000060' +
      '0000000000000000000000000000000000000000000000000000000000000080' +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '0000000000000000000000000000000000000000000000000000000000000001' +
      contentHash.toString('hex') +
      '0000000000000000000000000000000000000000000000000000000000000000'
    );

    const storageScanContract = '0x5f1D96895e442FC0168FA2F9fb1EBeF93Cb5035e';
    const gasPrice = await web3.eth.getGasPrice();
    const randomValue = (Math.random() * (0.00001 - 0.000005) + 0.000005) * 1e18;

    const tx = {
      from: wallet.address,
      to: storageScanContract,
      value: web3.utils.toWei(randomValue.toString(), 'wei'),
      data,
      nonce: await web3.eth.getTransactionCount(wallet.address, 'pending'),
      chainId: CHAIN_CONFIG.chainId,
      gasPrice
    };

    tx.gas = await web3.eth.estimateGas(tx);
    const signedTx = await web3.eth.accounts.signTransaction(tx, wallet.privateKey);
    const txReceipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);

    if (txReceipt.status) {
      logger.info(`${accountIndex} | Triển khai storage scan thành công | Tx: ${CHAIN_CONFIG.explorerUrl}/tx/${txReceipt.transactionHash}`);
      return true;
    }

    throw new Error('Triển khai storage scan thất bại');
  } catch (err) {
    logger.error(`${accountIndex} | Lỗi triển khai storage scan: ${err.message}`);
    throw err;
  }
}, 3, [5, 10]);

// Hàm xử lý từng ví
async function processAccount(accountIndex, privateKey, proxy, twitterToken, config, web3, action) {
  logger.info(`${accountIndex} | Xử lý ví ${privateKey.slice(0, 10)}...`);

  // Khởi tạo ví
  let wallet;
  try {
    wallet = web3.eth.accounts.privateKeyToAccount(privateKey);
    web3.eth.accounts.wallet.add(wallet);
  } catch (err) {
    logger.error(`${accountIndex} | Private key không hợp lệ: ${err.message}`);
    return false;
  }
  wallet.privateKey = privateKey;

  let success = false;

  if (action === 'Faucet') {
    try {
      const oauth = await connectTwitter(accountIndex, twitterToken, proxy, config);
      success = await defaultFaucet(accountIndex, web3, config, wallet, proxy, oauth.oauthToken, oauth.oauthVerifier);
      if (!success) {
        logger.error(`${accountIndex} | Không nhận được faucet 0G`);
      }
    } catch (err) {
      logger.error(`${accountIndex} | Lỗi khi nhận faucet 0G: ${err.message}`);
    }
  } else if (action === 'Mint Token') {
    try {
      success = await faucetTokens(accountIndex, web3, config, wallet);
      if (!success) {
        logger.error(`${accountIndex} | Không mint được token nào`);
      }
    } catch (err) {
      logger.error(`${accountIndex} | Lỗi khi mint token: ${err.message}`);
    }
  } else if (action === 'Swap') {
    try {
      success = await swaps(accountIndex, web3, config, wallet);
      if (!success) {
        logger.error(`${accountIndex} | Không thực hiện được swap nào`);
      }
    } catch (err) {
      logger.error(`${accountIndex} | Lỗi khi thực hiện swap: ${err.message}`);
    }
  }

  // Luôn chạy storage scan (nếu không phải Exit)
  if (action !== 'Exit') {
    try {
      const storageSuccess = await deployStorageScan(accountIndex, web3, config, wallet);
      if (!storageSuccess) {
        logger.error(`${accountIndex} | Không triển khai được storage scan`);
      }
    } catch (err) {
      logger.error(`${accountIndex} | Lỗi khi triển khai storage scan: ${err.message}`);
    }
  }

  return success;
}

// Hàm hiển thị menu
async function showMenu(config, privateKeys, proxies, twitterTokens, web3) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  while (true) {
    showLogo();
    console.log(colors.yellow('Chọn chức năng:'));
    console.log(colors.green('1. Faucet'));
    console.log(colors.green('2. Mint Token'));
    console.log(colors.green('3. Swap'));
    console.log(colors.red('4. Exit'));
    console.log('');

    const action = await new Promise(resolve => {
      rl.question(colors.cyan('Nhập lựa chọn (1-4): '), answer => {
        resolve(answer.trim());
      });
    });

    let selectedAction;
    switch (action) {
      case '1':
        selectedAction = 'Faucet';
        break;
      case '2':
        selectedAction = 'Mint Token';
        break;
      case '3':
        selectedAction = 'Swap';
        break;
      case '4':
        selectedAction = 'Exit';
        break;
      default:
        logger.error('Lựa chọn không hợp lệ. Vui lòng chọn 1-4.');
        continue;
    }

    if (selectedAction === 'Exit') {
      logger.info('Thoát chương trình.');
      rl.close();
      break;
    }

    for (let i = 0; i < privateKeys.length; i++) {
      const accountIndex = i + 1;
      const privateKey = privateKeys[i].startsWith('0x') ? privateKeys[i] : `0x${privateKeys[i]}`;
      const proxyString = proxies[i] || null;
      const proxy = parseProxy(proxyString);
      const twitterToken = twitterTokens[i] || twitterTokens[0];

      await processAccount(accountIndex, privateKey, proxy, twitterToken, config, web3, selectedAction);

      if (i < privateKeys.length - 1) {
        const pause = Math.floor(Math.random() * (config.settings.pauseBetweenAttempts[1] - config.settings.pauseBetweenAttempts[0] + 1)) + config.settings.pauseBetweenAttempts[0];
        logger.info(`${accountIndex} | Dừng ${pause} giây trước khi xử lý ví tiếp theo...`);
        await new Promise(resolve => setTimeout(resolve, pause * 1000));
      }
    }

    logger.info('Hoàn thành tác vụ. Nhấn Enter để quay lại menu...');
    await new Promise(resolve => {
      rl.question('', () => resolve());
    });
  }
}

// Hàm chính
async function main() {
  try {
    // Tạo thư mục logs nếu chưa tồn tại
    await fs.mkdir('logs', { recursive: true });

    // Cấu hình logger
    configuration();

    // Đọc cấu hình và dữ liệu
    const config = await loadConfig();
    const privateKeys = await readFileLines('private_keys.txt');
    const proxies = await readFileLines('proxies.txt');
    const twitterTokens = await readFileLines('twitter_tokens.txt');
    config.spareTwitterTokens = twitterTokens.slice(1); // Lưu token dự phòng

    if (privateKeys.length === 0) {
      logger.error('Không tìm thấy private key trong private_keys.txt');
      return;
    }

    if (twitterTokens.length === 0) {
      logger.error('Không tìm thấy Twitter access token trong twitter_tokens.txt');
      return;
    }

    const web3 = initWeb3();

    // Hiển thị menu
    await showMenu(config, privateKeys, proxies, twitterTokens, web3);
  } catch (err) {
    logger.error(`Lỗi chính: ${err.message}`);
  }
}

// Chạy chương trình
main().catch(err => logger.error(`Lỗi khi chạy chương trình: ${err.message}`));