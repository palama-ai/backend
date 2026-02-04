import React, { useState, useRef } from 'react';
import Icon from '../AppIcon';
import Button from '../ui/Button';
import Input from '../ui/Input';

const API_BASE = import.meta.env?.VITE_BACKEND_URL || 'https://backend-three-sigma-81.vercel.app/api';

const getHeaders = () => {
    const token = JSON.parse(localStorage.getItem('gm_auth') || '{}')?.token;
    return { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
};

/**
 * ProductOnboardingModal - Smart product addition wizard
 * 
 * 3-step flow:
 * 1. Barcode lookup (primary path)
 * 2. AI image analysis (fallback when barcode not found)
 * 3. Review & complete form
 */
const ProductOnboardingModal = ({ onClose, onSave }) => {
    const [step, setStep] = useState(1);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    // Barcode state
    const [barcode, setBarcode] = useState('');
    const [barcodeStatus, setBarcodeStatus] = useState(null); // null, 'found', 'not-found'

    // AI Analysis state
    const [selectedFile, setSelectedFile] = useState(null);
    const [filePreview, setFilePreview] = useState(null);
    const [analysisResult, setAnalysisResult] = useState(null);

    // Form data (populated by barcode or AI analysis)
    const [formData, setFormData] = useState({
        name: '',
        brand: '',
        ingredients: '',
        description: '',
        price: '',
        purchase_url: '',
        category: '',
        image_url: '',
        published: 0
    });

    const fileInputRef = useRef(null);

    // Step 1: Barcode Lookup
    const handleBarcodeLookup = async () => {
        if (!barcode || barcode.length < 8) {
            setError('Please enter a valid barcode (8-14 digits)');
            return;
        }

        setLoading(true);
        setError('');
        setBarcodeStatus(null);

        try {
            const res = await fetch(`${API_BASE}/barcode/lookup/${barcode}`, {
                headers: getHeaders()
            });

            const data = await res.json();

            if (data.found && data.product) {
                // Product found - populate form and go to step 3
                setFormData(prev => ({
                    ...prev,
                    name: data.product.name || '',
                    brand: data.product.brand || '',
                    ingredients: data.product.ingredients || '',
                    description: data.product.suggestedDescription || '',
                    category: data.product.category || '',
                    image_url: data.product.imageUrl || ''
                }));
                setBarcodeStatus('found');
                setStep(3);
            } else {
                // Not found - show fallback option
                setBarcodeStatus('not-found');
            }
        } catch (err) {
            console.error('Barcode lookup error:', err);
            setError('Failed to lookup barcode. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    // Handle file selection for AI analysis
    const handleFileSelect = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // Validate file type
        const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        if (!allowedTypes.includes(file.type)) {
            setError('Unsupported file type. Please use JPEG, PNG, or WebP.');
            return;
        }

        // Validate file size (10MB max)
        if (file.size > 10 * 1024 * 1024) {
            setError('File too large. Maximum size is 10MB.');
            return;
        }

        setError('');
        setSelectedFile(file);

        // Create preview
        const reader = new FileReader();
        reader.onloadend = () => {
            setFilePreview(reader.result);
        };
        reader.readAsDataURL(file);
    };

    // Step 2: AI Image Analysis
    const handleAIAnalysis = async () => {
        if (!selectedFile) {
            setError('Please select an image to analyze');
            return;
        }

        setLoading(true);
        setError('');

        try {
            // Convert file to base64
            const reader = new FileReader();
            reader.readAsDataURL(selectedFile);

            reader.onload = async () => {
                try {
                    const base64Image = reader.result;

                    const res = await fetch(`${API_BASE}/product-onboarding/analyze-image`, {
                        method: 'POST',
                        headers: getHeaders(),
                        body: JSON.stringify({ image: base64Image })
                    });

                    const data = await res.json();

                    if (res.ok && data.success) {
                        // Populate form with AI results
                        setFormData(prev => ({
                            ...prev,
                            name: data.data.name || '',
                            brand: data.data.brand || '',
                            ingredients: data.data.ingredients || '',
                            description: data.data.suggestedDescription || ''
                        }));
                        setAnalysisResult(data.data);
                        setStep(3);
                    } else {
                        throw new Error(data.error || 'Failed to analyze image');
                    }
                } catch (err) {
                    console.error('AI analysis error:', err);
                    setError(err.message || 'Failed to analyze image. Please try again.');
                } finally {
                    setLoading(false);
                }
            };

            reader.onerror = () => {
                setError('Failed to read the image');
                setLoading(false);
            };
        } catch (err) {
            console.error('File read error:', err);
            setError('Failed to read the file');
            setLoading(false);
        }
    };

    // Step 3: Submit the product
    const handleSubmit = async (e) => {
        e.preventDefault();

        // Validation
        if (!formData.name) {
            setError('Product name is required');
            return;
        }
        if (!formData.price) {
            setError('Price is required');
            return;
        }
        if (!formData.purchase_url) {
            setError('Purchase URL is required');
            return;
        }

        setLoading(true);
        setError('');

        try {
            const result = await onSave(formData);
            if (result?.success) {
                onClose();
            } else if (result?.error) {
                setError(result.error);
            }
        } catch (err) {
            setError(err.message || 'Failed to save product');
        } finally {
            setLoading(false);
        }
    };

    // Skip to manual entry
    const handleSkipToManual = () => {
        setStep(3);
    };

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl">
                {/* Header */}
                <div className="p-6 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                    <div>
                        <h2 className="text-xl font-bold text-slate-900 dark:text-white">
                            Add New Product
                        </h2>
                        <p className="text-sm text-slate-500 mt-0.5">
                            {step === 1 && 'Step 1: Barcode Lookup'}
                            {step === 2 && 'Step 2: AI Image Analysis'}
                            {step === 3 && 'Step 3: Review & Complete'}
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors"
                    >
                        <Icon name="X" size={20} className="text-slate-500" />
                    </button>
                </div>

                {/* Progress Steps */}
                <div className="px-6 pt-4">
                    <div className="flex items-center justify-center gap-2">
                        {[1, 2, 3].map((s) => (
                            <div key={s} className="flex items-center">
                                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-all ${s === step
                                    ? 'bg-gradient-to-r from-pink-500 to-rose-500 text-white shadow-lg shadow-pink-500/25'
                                    : s < step
                                        ? 'bg-emerald-500 text-white'
                                        : 'bg-slate-200 dark:bg-slate-700 text-slate-500'
                                    }`}>
                                    {s < step ? <Icon name="Check" size={16} /> : s}
                                </div>
                                {s < 3 && (
                                    <div className={`w-12 h-0.5 mx-1 ${s < step ? 'bg-emerald-500' : 'bg-slate-200 dark:bg-slate-700'}`} />
                                )}
                            </div>
                        ))}
                    </div>
                </div>

                {/* Error Alert */}
                {error && (
                    <div className="mx-6 mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-sm text-red-600 dark:text-red-400 flex items-center gap-2">
                        <Icon name="AlertCircle" size={16} />
                        {error}
                    </div>
                )}

                {/* Step 1: Barcode Lookup */}
                {step === 1 && (
                    <div className="p-6 space-y-5">
                        <div className="text-center py-4">
                            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-pink-100 to-rose-100 dark:from-pink-500/10 dark:to-rose-500/10 flex items-center justify-center mx-auto mb-4">
                                <Icon name="ScanBarcode" size={32} className="text-pink-500" />
                            </div>
                            <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2">
                                Enter Product Barcode
                            </h3>
                            <p className="text-sm text-slate-500">
                                We'll automatically search for product information in our database
                            </p>
                        </div>

                        <div>
                            <Input
                                type="text"
                                value={barcode}
                                onChange={(e) => setBarcode(e.target.value.replace(/\D/g, ''))}
                                placeholder="Enter barcode (e.g., 4005808220557)"
                                className="rounded-xl text-center text-lg tracking-widest"
                                maxLength={14}
                            />
                        </div>

                        {barcodeStatus === 'not-found' && (
                            <div className="p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl">
                                <div className="flex items-start gap-3">
                                    <Icon name="AlertTriangle" size={20} className="text-amber-500 flex-shrink-0 mt-0.5" />
                                    <div>
                                        <h4 className="font-semibold text-amber-700 dark:text-amber-400">
                                            Barcode Not Recognized
                                        </h4>
                                        <p className="text-sm text-amber-600 dark:text-amber-300 mt-1">
                                            Don't worry! Take a clear photo of the back of the product (where the ingredients and product name are) and AI will handle the rest.
                                        </p>
                                        <button
                                            onClick={() => setStep(2)}
                                            className="mt-3 text-sm font-semibold text-amber-700 dark:text-amber-400 flex items-center gap-1 hover:underline"
                                        >
                                            <Icon name="Camera" size={16} />
                                            Analyze Product Image
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}

                        <div className="flex gap-3 pt-2">
                            <button
                                onClick={handleBarcodeLookup}
                                disabled={loading || !barcode}
                                className="flex-1 px-4 py-3 bg-gradient-to-r from-pink-500 to-rose-500 text-white rounded-xl font-semibold shadow-lg shadow-pink-500/25 hover:shadow-xl disabled:opacity-50 transition-all flex items-center justify-center gap-2"
                            >
                                {loading ? (
                                    <Icon name="Loader2" size={18} className="animate-spin" />
                                ) : (
                                    <Icon name="Search" size={18} />
                                )}
                                Search
                            </button>
                        </div>

                        <div className="text-center">
                            <button
                                onClick={handleSkipToManual}
                                className="text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                            >
                                Skip, I'll enter details manually
                            </button>
                        </div>
                    </div>
                )}

                {/* Step 2: AI Image Analysis */}
                {step === 2 && (
                    <div className="p-6 space-y-5">
                        <div className="text-center py-2">
                            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-purple-100 to-fuchsia-100 dark:from-purple-500/10 dark:to-fuchsia-500/10 flex items-center justify-center mx-auto mb-4">
                                <Icon name="Sparkles" size={32} className="text-purple-500" />
                            </div>
                            <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2">
                                AI Image Analysis
                            </h3>
                            <p className="text-sm text-slate-500">
                                Take a clear photo of the back of the product
                            </p>
                        </div>

                        {/* Image Upload Area */}
                        <div
                            className="relative border-2 border-dashed border-slate-300 dark:border-slate-600 rounded-2xl p-8 text-center hover:border-pink-400 transition-colors cursor-pointer"
                            onClick={() => fileInputRef.current?.click()}
                        >
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/jpeg,image/jpg,image/png,image/webp"
                                onChange={handleFileSelect}
                                className="hidden"
                            />

                            {filePreview ? (
                                <div className="relative">
                                    <img
                                        src={filePreview}
                                        alt="Preview"
                                        className="max-h-48 mx-auto rounded-xl object-cover shadow-lg"
                                    />
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setSelectedFile(null);
                                            setFilePreview(null);
                                        }}
                                        className="absolute top-2 right-2 p-1.5 bg-red-500 text-white rounded-full hover:bg-red-600 shadow-lg"
                                    >
                                        <Icon name="X" size={14} />
                                    </button>
                                    <p className="text-xs text-slate-500 mt-3">{selectedFile?.name}</p>
                                </div>
                            ) : (
                                <div>
                                    <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-3">
                                        <Icon name="ImagePlus" size={28} className="text-slate-400" />
                                    </div>
                                    <p className="text-sm font-medium text-slate-600 dark:text-slate-400">
                                        Click to select an image
                                    </p>
                                    <p className="text-xs text-slate-400 mt-1">
                                        JPEG, PNG, WebP (Max 10MB)
                                    </p>
                                </div>
                            )}
                        </div>

                        <div className="flex gap-3">
                            <button
                                onClick={() => setStep(1)}
                                className="flex-1 px-4 py-3 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-700 dark:text-slate-300 font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                            >
                                Back
                            </button>
                            <button
                                onClick={handleAIAnalysis}
                                disabled={loading || !selectedFile}
                                className="flex-1 px-4 py-3 bg-gradient-to-r from-purple-500 to-fuchsia-500 text-white rounded-xl font-semibold shadow-lg shadow-purple-500/25 hover:shadow-xl disabled:opacity-50 transition-all flex items-center justify-center gap-2"
                            >
                                {loading ? (
                                    <>
                                        <Icon name="Loader2" size={18} className="animate-spin" />
                                        Analyzing...
                                    </>
                                ) : (
                                    <>
                                        <Icon name="Sparkles" size={18} />
                                        Analyze with AI
                                    </>
                                )}
                            </button>
                        </div>

                        <div className="text-center">
                            <button
                                onClick={handleSkipToManual}
                                className="text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                            >
                                Skip, I'll enter details manually
                            </button>
                        </div>
                    </div>
                )}

                {/* Step 3: Review & Complete */}
                {step === 3 && (
                    <form onSubmit={handleSubmit} className="p-6 space-y-5">
                        {/* Success banner if data was auto-filled */}
                        {(barcodeStatus === 'found' || analysisResult) && (
                            <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-xl text-sm text-emerald-700 dark:text-emerald-400 flex items-center gap-2">
                                <Icon name="CheckCircle" size={16} />
                                {barcodeStatus === 'found'
                                    ? 'Data auto-filled from database'
                                    : 'Data successfully extracted by AI'}
                            </div>
                        )}

                        <div>
                            <label className="block text-sm font-semibold text-slate-900 dark:text-white mb-2">Product Name *</label>
                            <Input
                                value={formData.name}
                                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                placeholder="e.g., Vitamin C Serum"
                                required
                                className="rounded-xl"
                            />
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="block text-sm font-semibold text-slate-900 dark:text-white mb-2">Brand</label>
                                <Input
                                    value={formData.brand}
                                    onChange={(e) => setFormData({ ...formData, brand: e.target.value })}
                                    placeholder="Brand name"
                                    className="rounded-xl"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-slate-900 dark:text-white mb-2">Category</label>
                                <select
                                    value={formData.category}
                                    onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                                    className="w-full px-4 py-2.5 border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-pink-500/50"
                                >
                                    <option value="">Select</option>
                                    <option value="cleanser">Cleanser</option>
                                    <option value="toner">Toner</option>
                                    <option value="serum">Serum</option>
                                    <option value="moisturizer">Moisturizer</option>
                                    <option value="sunscreen">Sunscreen</option>
                                    <option value="mask">Mask</option>
                                    <option value="treatment">Treatment</option>
                                </select>
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-semibold text-slate-900 dark:text-white mb-2">
                                Ingredients
                                <span className="text-xs font-normal text-slate-400 ml-2">(comma-separated)</span>
                            </label>
                            <textarea
                                value={formData.ingredients}
                                onChange={(e) => setFormData({ ...formData, ingredients: e.target.value })}
                                placeholder="Water, Glycerin, Niacinamide..."
                                className="w-full px-4 py-3 border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white min-h-[80px] focus:outline-none focus:ring-2 focus:ring-pink-500/50"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-semibold text-slate-900 dark:text-white mb-2">Description</label>
                            <textarea
                                value={formData.description}
                                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                                placeholder="Product description..."
                                className="w-full px-4 py-3 border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white min-h-[80px] focus:outline-none focus:ring-2 focus:ring-pink-500/50"
                            />
                            {analysisResult?.suggestedDescription && (
                                <p className="text-xs text-slate-400 mt-1 flex items-center gap-1">
                                    <Icon name="Sparkles" size={12} />
                                    Description generated by AI
                                </p>
                            )}
                        </div>

                        {/* Mandatory seller fields */}
                        <div className="border-t border-slate-200 dark:border-slate-800 pt-5">
                            <h4 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                                <Icon name="DollarSign" size={16} className="text-pink-500" />
                                Sale Information (Required)
                            </h4>

                            <div className="grid grid-cols-2 gap-4 mb-4">
                                <div>
                                    <label className="block text-sm font-semibold text-slate-900 dark:text-white mb-2">Price ($) *</label>
                                    <Input
                                        type="number"
                                        step="0.01"
                                        value={formData.price}
                                        onChange={(e) => setFormData({ ...formData, price: e.target.value })}
                                        placeholder="29.99"
                                        required
                                        className="rounded-xl"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-semibold text-slate-900 dark:text-white mb-2">Product Image</label>
                                    <Input
                                        type="url"
                                        value={formData.image_url}
                                        onChange={(e) => setFormData({ ...formData, image_url: e.target.value })}
                                        placeholder="Image URL"
                                        className="rounded-xl"
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-semibold text-slate-900 dark:text-white mb-2">Purchase URL *</label>
                                <Input
                                    type="url"
                                    value={formData.purchase_url}
                                    onChange={(e) => setFormData({ ...formData, purchase_url: e.target.value })}
                                    placeholder="https://yourstore.com/product"
                                    required
                                    className="rounded-xl"
                                />
                            </div>
                        </div>

                        <div className="flex items-center gap-3 p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl">
                            <input
                                type="checkbox"
                                id="published"
                                checked={formData.published === 1}
                                onChange={(e) => setFormData({ ...formData, published: e.target.checked ? 1 : 0 })}
                                className="w-5 h-5 accent-pink-500 rounded"
                            />
                            <label htmlFor="published" className="text-sm font-medium text-slate-900 dark:text-white">
                                Publish product (visible to users)
                            </label>
                        </div>

                        <div className="flex gap-3 pt-2">
                            <button
                                type="button"
                                onClick={() => setStep(barcodeStatus === 'not-found' || analysisResult ? 2 : 1)}
                                className="flex-1 px-4 py-3 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-700 dark:text-slate-300 font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                            >
                                Back
                            </button>
                            <button
                                type="submit"
                                disabled={loading}
                                className="flex-1 px-4 py-3 bg-gradient-to-r from-pink-500 to-rose-500 text-white rounded-xl font-semibold shadow-lg shadow-pink-500/25 hover:shadow-xl disabled:opacity-50 transition-all flex items-center justify-center gap-2"
                            >
                                {loading ? (
                                    <Icon name="Loader2" size={18} className="animate-spin" />
                                ) : (
                                    <Icon name="Check" size={18} />
                                )}
                                Save Product
                            </button>
                        </div>
                    </form>
                )}
            </div>
        </div>
    );
};

export default ProductOnboardingModal;
