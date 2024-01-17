const { Web3 } = require('web3');
const momentjs = require('moment');
const BNify = require('bignumber.js');
const Multicall = require('./Multicall.js');
const erc20ABI = require('./abis/ERC20.json');
const idleCDOAbi = require('./abis/idleCDO.json');
const amphorPoolAbi = require('./abis/AmphorPoolAbi.json');

require('dotenv').config()

const web3 = new Web3(new Web3.providers.HttpProvider(`https://eth-mainnet.g.alchemy.com/v2/${process.env.MAINNET_ALCHEMY_KEY}`));
const multiCall = new Multicall(web3);
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const CDOs = [
  {
    CDO:{
      startBlock: 18769315,
      performanceFee: 0.15,
      performanceFeeDiscounted: 0.07,
      address: '0x9e0c5ee5e4B187Cf18B23745FCF2b6aE66a9B52f',
      contract: new web3.eth.Contract(idleCDOAbi, '0x9e0c5ee5e4B187Cf18B23745FCF2b6aE66a9B52f'),
    },
    Pool:{
      startBlock: 18871448,
      address: '0x2791EB5807D69Fe10C02eED6B4DC12baC0701744',
      contract: new web3.eth.Contract(amphorPoolAbi, '0x2791EB5807D69Fe10C02eED6B4DC12baC0701744'),
    },
    AA:{
      type: 'AA',
      token:'wstETH',
      decimals: 18,
      abi: erc20ABI,
      name: 'AA_amphor_wstETH',
      address:'0x28D8a22c6689aC1e2DDC43Ca6F85c520457351C1',
      trancheContract: new web3.eth.Contract(erc20ABI, '0x28D8a22c6689aC1e2DDC43Ca6F85c520457351C1')
    },
    BB:{
      type: 'BB',
      token:'wstETH',
      decimals: 18,
      abi: erc20ABI,
      name: 'BB_amphor_wstETH',
      address:'0xEfC4f43737Fd336fa8A8254454Ced1e421804b16',
      trancheContract: new web3.eth.Contract(erc20ABI, '0xEfC4f43737Fd336fa8A8254454Ced1e421804b16')
    },
  }
]

function sortArrayByKey(array, key, order = 'asc') {
  const val1 = order === 'asc' ? -1 : 1
  const val2 = order === 'asc' ? 1 : -1
  return [...array].sort((a, b) => (parseInt(a[key]) < parseInt(b[key]) ? val1 : val2));
}

function getBlockBalances(transferEvents, targetBlockNumber) {
  const balances = {};

  transferEvents.forEach(event => {
    const blockNumber = event.blockNumber;

    if (blockNumber <= targetBlockNumber) {
      const sender = event.returnValues.from;
      const receiver = event.returnValues.to;
      const value = event.returnValues.value;

      // Aggiorna il saldo del mittente
      if (sender !== ZERO_ADDRESS){
        if (!balances[sender]) {
          balances[sender] = BNify(0);
        }
        balances[sender] = balances[sender].minus(BNify(value));
      }

      // Aggiorna il saldo del ricevente
      if (receiver !== ZERO_ADDRESS){
        if (!balances[receiver]) {
          balances[receiver] = BNify(0);
        }
        balances[receiver] = balances[receiver].plus(BNify(value));
      }
    }
  });

  return balances;
}

async function main(){

  const promises = CDOs.reduce( (promises, cdoInfo) => {
    const cdoConfig = cdoInfo.CDO
    const poolConfig = cdoInfo.Pool
    const epochStartPromise = poolConfig.contract.getPastEvents('EpochStart', {
      fromBlock: poolConfig.startBlock,
      toBlock: 'latest'
    }).then( events => ({events, cdoAddress: cdoConfig.address}) );
    promises.startEvents.push(epochStartPromise)

    const epochEndPromise = poolConfig.contract.getPastEvents('EpochEnd', {
      fromBlock: poolConfig.startBlock,
      toBlock: 'latest'
    }).then( events => ({events, cdoAddress: cdoConfig.address}) );
    promises.endEvents.push(epochEndPromise)

    const aaTransfers = cdoInfo.AA.trancheContract.getPastEvents('Transfer', {
      fromBlock: cdoConfig.startBlock,
      toBlock: 'latest'
    }).then( transfers => ({transfers, cdoAddress: cdoConfig.address}) );

    promises.aaTransfers.push(aaTransfers)

    const bbTransfers = cdoInfo.BB.trancheContract.getPastEvents('Transfer', {
      fromBlock: cdoConfig.startBlock,
      toBlock: 'latest'
    }).then( transfers => ({transfers, cdoAddress: cdoConfig.address}) );

    promises.bbTransfers.push(bbTransfers)

    return promises
  }, {
    endEvents: [],
    startEvents: [],
    aaTransfers: [],
    bbTransfers: []
  })

  const [
    aaTransfers,
    bbTransfers,
    epochStartEvents,
    epochEndEvents
  ] = await Promise.all([
    Promise.all(promises.aaTransfers),
    Promise.all(promises.bbTransfers),
    Promise.all(promises.startEvents),
    Promise.all(promises.endEvents)
  ])

  // Get cdos epochs start/end blocks
  const cdosEpochsTranchePricesMulticalls = {}

  const cdosEpochs = epochStartEvents.reduce( (cdosEpochs, cdoEpochStart) => {
    const cdoAddress = cdoEpochStart.cdoAddress
    cdosEpochs[cdoAddress] = []
    cdosEpochsTranchePricesMulticalls[cdoAddress] = []
    
    const cdoInfo = CDOs.find( cdoInfo => cdoInfo.CDO.address === cdoAddress )

    sortArrayByKey(cdoEpochStart.events, 'blockNumber').forEach( epochStartEvent => {
      const cdoEpochEnd = epochEndEvents.find( epochEnd => epochEnd.cdoAddress === cdoAddress )
      const cdoEpochEndEvents = sortArrayByKey(cdoEpochEnd.events, 'blockNumber')
      const epochEndEvent = cdoEpochEndEvents.find( epochEndEvent => parseInt(epochEndEvent.blockNumber)>parseInt(epochStartEvent.blockNumber) )

      const startBlock = parseInt(epochStartEvent.blockNumber)
      const endBlock = epochEndEvent ? parseInt(epochEndEvent.blockNumber) : null

      cdosEpochs[cdoAddress].push({startBlock, endBlock})

      if (!cdosEpochsTranchePricesMulticalls[cdoAddress][startBlock]){
        cdosEpochsTranchePricesMulticalls[cdoAddress][startBlock] =  []
      }

      cdosEpochsTranchePricesMulticalls[cdoAddress][startBlock].push(multiCall.getCallData(cdoInfo.CDO.contract, 'virtualPrice', [cdoInfo.AA.address], {cdoAddress, blockNumber: startBlock, type:'AA'}))
      cdosEpochsTranchePricesMulticalls[cdoAddress][startBlock].push(multiCall.getCallData(cdoInfo.CDO.contract, 'virtualPrice', [cdoInfo.BB.address], {cdoAddress, blockNumber: startBlock, type:'BB'}))
      if (endBlock){
        if (!cdosEpochsTranchePricesMulticalls[cdoAddress][endBlock]){
          cdosEpochsTranchePricesMulticalls[cdoAddress][endBlock] =  []
        }
        cdosEpochsTranchePricesMulticalls[cdoAddress][endBlock].push(multiCall.getCallData(cdoInfo.CDO.contract, 'virtualPrice', [cdoInfo.AA.address], {cdoAddress, blockNumber: endBlock, type:'AA'}))
        cdosEpochsTranchePricesMulticalls[cdoAddress][endBlock].push(multiCall.getCallData(cdoInfo.CDO.contract, 'virtualPrice', [cdoInfo.BB.address], {cdoAddress, blockNumber: endBlock, type:'BB'}))
      }
    })

    return cdosEpochs
  }, {})

  const multicallPromises = Object.keys(cdosEpochsTranchePricesMulticalls).reduce( (multicallPromises, cdoAddress) => {
    Object.keys(cdosEpochsTranchePricesMulticalls[cdoAddress]).forEach( blockNumber => {
      const calls = cdosEpochsTranchePricesMulticalls[cdoAddress][blockNumber]
      multicallPromises.push(multiCall.executeMulticalls(calls, null, blockNumber).then( prices => ({prices, cdoAddress, blockNumber}) ))
    })
    return multicallPromises
  }, [])

  // Execute multicalls
  const cdoEpochsTranchePrices = await Promise.all(multicallPromises)

  Object.keys(cdosEpochs).forEach( cdoAddress => {

    const cdoInfo = CDOs.find( cdoInfo => cdoInfo.CDO.address === cdoAddress )

    cdosEpochs[cdoAddress].forEach( epochInfo => {
      const startPrices = cdoEpochsTranchePrices.find( res => (res.cdoAddress === cdoAddress && parseInt(res.blockNumber) === parseInt(epochInfo.startBlock)) )
      const endPrices = cdoEpochsTranchePrices.find( res => (res.cdoAddress === cdoAddress && parseInt(res.blockNumber) === parseInt(epochInfo.endBlock)) )

      const startPriceAA = startPrices.prices.find( price => price.type === 'AA' ).data
      const startPriceBB = startPrices.prices.find( price => price.type === 'BB' ).data

      const endPriceAA = endPrices ? endPrices.prices.find( price => price.type === 'AA' ).data : null
      const endPriceBB = endPrices ? endPrices.prices.find( price => price.type === 'BB' ).data : null

      epochInfo.AA = {
        startPrice: BNify(startPriceAA).div(1e18),
        endPrice: BNify(endPriceAA).div(1e18),
        netProfitPercentage: BNify(endPriceAA).div(1e18).div(BNify(startPriceAA).div(1e18)).minus(1),
        feeRebate: {}
      }

      epochInfo.BB = {
        startPrice: BNify(startPriceBB).div(1e18),
        endPrice: BNify(endPriceBB).div(1e18),
        netProfitPercentage: BNify(endPriceBB).div(1e18).div(BNify(startPriceBB).div(1e18)).minus(1),
        feeRebate: {}
      }

      if (!epochInfo.endBlock){
        return;
      }

      const cdoAATransfers = aaTransfers.find( event => event.cdoAddress === cdoAddress ).transfers
      const cdoBBTransfers = bbTransfers.find( event => event.cdoAddress === cdoAddress ).transfers

      const userAABalances = getBlockBalances(cdoAATransfers, epochInfo.startBlock)
      const userBBBalances = getBlockBalances(cdoBBTransfers, epochInfo.startBlock)

      epochInfo.feeRebate = {}

      epochInfo.AA.feeRebate = Object.keys(userAABalances).reduce( (usersAccruedFees, userAddress) => {
        const userBalance = userAABalances[userAddress].div(1e18)
        const userNetProfit = userBalance.times(epochInfo.AA.netProfitPercentage)
        const userGrossProfit = userNetProfit.times(1).div(BNify(1).minus(cdoInfo.CDO.performanceFee))
        const userGrossProfitDiscounted = userNetProfit.times(1).div(BNify(1).minus(cdoInfo.CDO.performanceFeeDiscounted))
        const feesToReturn = userGrossProfit.minus(userGrossProfitDiscounted)
        usersAccruedFees[userAddress] = feesToReturn

        if (!epochInfo.feeRebate[userAddress]){
          epochInfo.feeRebate[userAddress] = BNify(0)
        }
        epochInfo.feeRebate[userAddress] = epochInfo.feeRebate[userAddress].plus(feesToReturn)

        return usersAccruedFees
      }, {})

      epochInfo.BB.feeRebate = Object.keys(userBBBalances).reduce( (usersAccruedFees, userAddress) => {
        const userBalance = userBBBalances[userAddress].div(1e18)
        const userNetProfit = userBalance.times(epochInfo.BB.netProfitPercentage)
        const userGrossProfit = userNetProfit.times(1).div(BNify(1).minus(cdoInfo.CDO.performanceFee))
        const userGrossProfitDiscounted = userNetProfit.times(1).div(BNify(1).minus(cdoInfo.CDO.performanceFeeDiscounted))
        const feesToReturn = userGrossProfit.minus(userGrossProfitDiscounted)
        usersAccruedFees[userAddress] = feesToReturn

        if (!epochInfo.feeRebate[userAddress]){
          epochInfo.feeRebate[userAddress] = BNify(0)
        }
        epochInfo.feeRebate[userAddress] = epochInfo.feeRebate[userAddress].plus(feesToReturn)

        return usersAccruedFees
      }, {})

      Object.keys(epochInfo.feeRebate).forEach( userAddress => {
        const feesToReturn = epochInfo.feeRebate[userAddress]
        console.log(cdoAddress, userAddress, feesToReturn.toString())
      })
    })
  })
}

main()