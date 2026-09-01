function random_number_batch({
    min,
    max,
    count = 10,
}: {
    min: number
    max: number
    count?: number
}) {
    min = Math.ceil(min)
    max = Math.floor(max)

    const values = new Array(count)
        .fill(-1)
        .map(() => Math.floor(Math.random() * (max - min + 1)) + min)
    return { values }
}

function is_prime({ number }: { number: number }) {
    const n = Number(number)
    if (!Number.isInteger(n) || n < 2) {
        return { is_prime: false, reason: 'n必须是不小于2的整数' }
    }
    for (let i = 2, sqrt = Math.sqrt(n); i <= sqrt; i++) {
        if (n % i === 0) {
            return { is_prime: false }
        }
    }
    return { is_prime: true, number }
}

function filter_prime({ numbers }: { numbers: number[] }) {
    return { primes: numbers.filter(number => is_prime({ number }).is_prime) }
}

function find_prime({
    min,
    max,
    count = 10,
}: {
    min: number
    max: number
    count?: number
}) {
    const primes: number[] = []
    while (primes.length < count) {
        primes.push(
            ...random_number_batch({ min, max, count })
                .values.filter(number => !primes.includes(number))
                .filter(number => is_prime({ number }).is_prime)
        )
    }

    return { primes: primes.slice(0, count) }
}

// 注册工具

chatxt.runtime.exposeTool([
    {
        name: 'find_prime',
        description:
            '生成指定范围内的不重复的随机质数。返回任意个，参数：min (int) 最小值，max (int) 最大值。',
        parameters: chatxt.helpers.convertArgsToSchema([
            ['min', '最小值（包含）', Number],
            ['max', '最大值（包含）', Number],
            ['count', '数量', Number],
        ]),
        func: find_prime,
    },
    {
        name: 'is_prime',
        description: '判断一个数是不是质数。',
        parameters: chatxt.helpers.convertArgsToSchema([
            ['number', '一个自然数', Number],
        ]),
        func: is_prime,
    },
    {
        name: 'filter_prime',
        description: '筛选一大堆数中的质数。',
        parameters: chatxt.helpers.convertArgsToSchema([
            [
                'numbers',
                '一堆自然数',
                { type: 'array', contains: { type: 'number' } },
            ],
        ]),
        func: filter_prime,
    },
])
