import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import { Plus, ArrowLeft, Filter, Search, Calendar, DollarSign, Edit, Trash2, ScanText } from 'lucide-react'
import { api } from '@/utils/api'
import { formatCurrency } from '@/utils/formatters'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import Swal from 'sweetalert2'
import { useTranslation } from 'next-i18next'
import { formatDay } from '@/lib/date';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import { readPreferences } from '@/lib/preferences';

interface Transaction {
  id: number
  description: string
  amount: number
  type: 'income' | 'expense'
  category: string
  date: string
  created_at: string
  currency?: string
  convertedAmount?: number
  convertedCurrency?: string
}

const PAGE_SIZE = 200

// The currency the user chose in Settings, read from localStorage each time
// it is needed. The page re-reads it on mount and on every refresh (initial
// load, deletion); a change made in Settings applies when this page is next
// opened, since the two are never on screen together.
const currentCurrency = (): string => {
  try {
    return JSON.parse(localStorage.getItem('userPreferences') ?? '{}').currency || 'CAD'
  } catch {
    return 'CAD'
  }
}

export default function Transactions() {
  const router = useRouter()
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const { t, i18n } = useTranslation('common');

  const defaultCurrency = typeof window !== 'undefined' ? currentCurrency() : 'CAD'

  // Bumped by every reset/refresh. A response from an older generation (a slow
  // first load overtaken by a refresh after a deletion, or a Load more that
  // was in flight during one) is dropped rather than applied.
  const generation = useRef(0)

  // The latest `t`, read when a fetch reports an error. Holding it in a ref
  // keeps fetchTransactions stable: `t` changes identity when the language
  // does (the preference effect below can do that on mount), and a dependency
  // on it would refetch the list for a change of language.
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  // Without `before` this replaces the list (first load, deletion); with the
  // previous response's nextCursor it appends. The de-dupe on append is only a
  // belt: keyset paging already keeps pages from overlapping.
  const fetchTransactions = useCallback(async (before: string | null = null) => {
    const append = before !== null
    if (!append) generation.current += 1
    const mine = generation.current
    try {
      if (append) {
        setLoadingMore(true)
      } else {
        setLoading(true)
        setLoadingMore(false)
      }
      const cursorParam = append ? `&before=${encodeURIComponent(before)}` : ''
      const response = await api.get(
        `/transactions?limit=${PAGE_SIZE}${cursorParam}&targetCurrency=${currentCurrency()}`
      )
      if (mine !== generation.current) return
      const rows: Transaction[] = response.data.transactions
      setTransactions(prev => {
        if (!append) return rows
        const seen = new Set(prev.map(tx => tx.id))
        return [...prev, ...rows.filter(tx => !seen.has(tx.id))]
      })
      setNextCursor(response.data.nextCursor ?? null)
    } catch (error) {
      if (mine !== generation.current) return
      console.error('Error fetching transactions:', error)
      Swal.fire({
        icon: 'error',
        title: tRef.current('Failed to load transactions'),
        text: tRef.current('There was an error fetching transactions. Please try again later.')
      })
    } finally {
      // Each request clears only the flag it set, and only if still current.
      if (mine === generation.current) {
        if (append) setLoadingMore(false)
        else setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    const token = localStorage.getItem('token')
    if (!token) {
      router.push('/login')
      return
    }

    fetchTransactions()
  }, [router, fetchTransactions])

  useEffect(() => {
    // A language chosen in Settings wins; 'system' leaves the page's locale alone.
    const { language } = readPreferences();
    if (language !== 'system' && i18n.language !== language) i18n.changeLanguage(language);
  }, [i18n]);

  const filteredTransactions = transactions.filter(transaction => {
    const matchesSearch = transaction.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         transaction.category.toLowerCase().includes(searchTerm.toLowerCase())
    const matchesType = typeFilter === 'all' || transaction.type === typeFilter
    const matchesCategory = categoryFilter === 'all' || transaction.category === categoryFilter
    
    return matchesSearch && matchesType && matchesCategory
  })

  const filtersActive = searchTerm !== '' || typeFilter !== 'all' || categoryFilter !== 'all'

  const categories = [...new Set(transactions.map(t => t.category))]

  const handleDelete = async (id: number) => {
    const result = await Swal.fire({
      title: t('Are you sure?'),
      text: t('Are you sure you want to delete this transaction? This action cannot be undone.'),
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#d33',
      cancelButtonColor: '#3085d6',
      confirmButtonText: t('Yes, delete it!'),
      cancelButtonText: t('Cancel'),
    });
    if (!result.isConfirmed) {
      return;
    }
    try {
      setDeletingId(id)
      await api.delete(`/transactions/${id}`)
      Swal.fire({
        icon: 'success',
        title: t('Transaction deleted successfully'),
        text: t('The transaction has been deleted successfully.')
      })
      fetchTransactions() // Back to page 1
    } catch (error) {
      console.error('Error deleting transaction:', error)
      Swal.fire({
        icon: 'error',
        title: t('Failed to delete transaction'),
        text: t('There was an error deleting the transaction. Please try again later.')
      })
    } finally {
      setDeletingId(null)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary"></div>
      </div>
    )
  }

  return (
    <>
      <Head>
        <title>Transactions - TermPocket</title>
        <meta name="description" content="View and manage your recent transactions" />
      </Head>

      <div className="min-h-screen bg-background relative">
        {/* Header */}
        <div className="border-b bg-card">
          <div className="container mx-auto px-4 py-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-4">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => router.push('/')}
                  className="flex items-center"
                >
                  <ArrowLeft className="w-4 h-4 mr-2 sm:mr-2" />
                  <span className="hidden sm:inline">{t('Back to Dashboard')}</span>
                </Button>
                <div>
                  <h1 className="text-3xl font-bold">{t('Transactions')}</h1>
                  <p className="text-muted-foreground">
                    {t('Manage and track your financial activities')}
                  </p>
                </div>
              </div>
              <div className="hidden sm:flex items-center space-x-2">
                <Button variant="outline" onClick={() => router.push('/import')}>
                  <ScanText className="w-4 h-4 mr-2" />
                  {t('Import from screenshot')}
                </Button>
                <Button onClick={() => router.push('/transactions/new')}>
                  <Plus className="w-4 h-4 mr-2" />
                  {t('Add Transaction')}
                </Button>
              </div>
              {/* Mobile: the FAB adds a transaction; import needs its own button */}
              <Button variant="outline" size="icon" className="sm:hidden shrink-0" onClick={() => router.push('/import')} aria-label={t('Import from screenshot')}>
                <ScanText className="w-6 h-6" />
              </Button>
            </div>
          </div>
        </div>

        {/* FAB for mobile */}
        <button
          className="fixed bottom-6 right-6 z-50 flex sm:hidden items-center justify-center w-16 h-16 rounded-full bg-primary text-white shadow-lg fab-add-transaction"
          onClick={() => router.push('/transactions/new')}
          aria-label={t('Add Transaction')}
        >
          <Plus className="w-8 h-8" />
        </button>

        <div className="container mx-auto px-2 sm:px-4 py-8">
          {/* Filters */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Filter className="h-5 w-5" />
                {t('Filters')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                  <Input
                    placeholder={t('Search transactions...')}
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-12 py-3 rounded-lg text-base"
                  />
                </div>
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger className="py-3 rounded-lg text-base">
                    <SelectValue placeholder={t('Filter by type')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('All Types')}</SelectItem>
                    <SelectItem value="income">{t('Income')}</SelectItem>
                    <SelectItem value="expense">{t('Expense')}</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                  <SelectTrigger className="py-3 rounded-lg text-base">
                    <SelectValue placeholder={t('Filter by category')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('All Categories')}</SelectItem>
                    {categories.map(category => (
                      <SelectItem key={category} value={category}>
                        {t(category)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          {/* Transactions Table */}
          <Card>
            <CardHeader>
              <CardTitle>{t('All Transactions')}</CardTitle>
              <CardDescription>
                {t('transactionsFound', { count: filteredTransactions.length })}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {filteredTransactions.length > 0 ? (
                <div className="space-y-4">
                  {filteredTransactions.map((transaction) => (
                    <div
                      key={transaction.id}
                      className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 border rounded-xl bg-background transition-all hover:bg-white/5 hover:shadow-md hover:border-primary/30 shadow-sm"
                    >
                      <div className="flex items-center space-x-4">
                        <div className={`w-4 h-4 rounded-full ${transaction.type === 'income' ? 'bg-green-500' : 'bg-red-500'}`} />
                        <div>
                          <p className="font-medium text-base">{transaction.description}</p>
                          <div className="flex flex-wrap items-center space-x-2 text-sm text-muted-foreground">
                            <span>{t(transaction.category)}</span>
                            <span>•</span>
                            <span className="flex items-center gap-1">
                              <Calendar className="w-4 h-4" />
                              {formatDay(transaction.date)}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center space-x-4">
                        <div className="text-right">
                          <p className={`font-semibold text-lg ${transaction.type === 'income' ? 'text-green-600' : 'text-red-600'}`}>
                            {transaction.type === 'income' ? '+' : '-'}
                            {formatCurrency(
                              transaction.convertedAmount ?? transaction.amount,
                              transaction.convertedCurrency ?? transaction.currency ?? defaultCurrency
                            )}
                          </p>
                          <Badge
                            className={`text-xs px-3 py-1 rounded-full ${transaction.type === 'income' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}
                          >
                            {t(transaction.type)}
                          </Badge>
                        </div>
                        <div className="flex items-center space-x-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => router.push(`/transactions/edit/${transaction.id}`)}
                            className="h-10 w-10 p-0 flex items-center justify-center"
                            aria-label={t('Edit Transaction')}
                          >
                            <Edit className="w-6 h-6" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDelete(transaction.id)}
                            disabled={deletingId === transaction.id}
                            className="h-10 w-10 p-0 flex items-center justify-center text-red-600 hover:text-red-700 hover:bg-red-50"
                            aria-label={t('Delete Transaction')}
                          >
                            <Trash2 className="w-6 h-6" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12">
                  <DollarSign className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                  <h3 className="text-lg font-semibold mb-2">{t('No transactions found')}</h3>
                  <p className="text-muted-foreground mb-4">
                    {searchTerm || typeFilter !== 'all' || categoryFilter !== 'all' 
                      ? t('Try adjusting your filters') 
                      : t('Start by adding your first transaction')
                    }
                  </p>
                  <Button onClick={() => router.push('/transactions/new')}>
                    <Plus className="w-4 h-4 mr-2" />
                    {t('Add Transaction')}
                  </Button>
                </div>
              )}
              {nextCursor && (
                <div className="mt-6 flex flex-col items-center gap-2">
                  {filtersActive && (
                    <p className="text-sm text-muted-foreground text-center">
                      {t('Search and filters apply only to the transactions loaded so far.')}
                    </p>
                  )}
                  <Button
                    variant="outline"
                    onClick={() => fetchTransactions(nextCursor)}
                    disabled={loadingMore}
                  >
                    {loadingMore ? t('Loading...') : t('Load more')}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}

export async function getStaticProps({ locale }: { locale: string }) {
  return {
    props: {
      ...(await serverSideTranslations(locale, ['common'])),
    },
  };
}